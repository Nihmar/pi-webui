import { randomUUID, createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import type { ChatHandle, PiAdapter, WorkspaceData } from "./adapter.js";
import {
  truncatePreview,
  redactSecrets,
  type ChatItem,
  type ModelInfo,
  type QueueState,
  type RunStatus,
  type ServerEvent,
  type SessionSummary,
  type Snapshot,
  type ThinkingLevel,
  type ToolMode
} from "../shared/protocol.js";

const READONLY_TOOLS = ["read", "grep", "find", "ls"];

function opaqueFromReal(realPath: string): string {
  return Buffer.from(realPath, "utf8").toString("base64url");
}
function realFromOpaque(opaque: string): string {
  const s = Buffer.from(opaque, "base64url").toString("utf8");
  if (!s || s.includes("\0")) throw new Error("bad opaque id");
  return s;
}

let itemCounter = 0;
function newId(prefix: string): string {
  itemCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${itemCounter}-${randomUUID().slice(0, 6)}`;
}

// Opt-in raw SDK event logger to discover the exact event shapes a given Pi
// provider (e.g. a local llama.cpp model) emits. Enable with PI_WEBUI_DEBUG_EVENTS=1.
// Prints the event type plus a shallow, secret-redacted view of its keys so we can
// confirm how thinking and tool calls actually arrive without leaking credentials.
const DEBUG_EVENTS = process.env.PI_WEBUI_DEBUG_EVENTS === "1";
function logSdkEvent(ev: Record<string, unknown>): void {
  try {
    const type = String(ev.type ?? "?");
    const shape: Record<string, string> = {};
    for (const [k, v] of Object.entries(ev)) {
      if (k === "type") continue;
      if (v === null || v === undefined) shape[k] = String(v);
      else if (Array.isArray(v)) shape[k] = `array(${v.length})`;
      else if (typeof v === "object") shape[k] = `{ ${Object.keys(v as object).slice(0, 8).join(", ")} }`;
      else shape[k] = truncatePreview(String(redactSecrets(v)), 120);
    }
    // eslint-disable-next-line no-console
    console.log(`[pi-event] ${type}`, JSON.stringify(shape));
  } catch {
    /* ignore */
  }
}

// Detect inline reasoning wrapped in <think>…</think> that some local models
// (QwQ, DeepSeek-R1, …) stream inside their text output instead of as
// structured thinking_delta events. Returns the length of the longest suffix of
// `buf` that is a proper prefix of `tag`, so a tag split across deltas is held back.
function partialTailLen(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (buf.slice(buf.length - n) === tag.slice(0, n)) return n;
  }
  return 0;
}

// Pull display text out of the many shapes a tool result/partial can take:
// a plain string, an array of blocks, or an object with { text } / { content } / { output }.
function extractContentText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((c) => extractContentText(c)).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.content !== undefined) return extractContentText(o.content);
    if (typeof o.output === "string") return o.output;
    if (typeof o.message === "string") return o.message;
  }
  return "";
}

function chunkText(s: string, n: number): string[] {
  if (n <= 1) return [s];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

// Lazy singleton ModelRuntime to reuse auth/catalog
let cachedModelRuntime: unknown | undefined;
async function getModelRuntime(): Promise<unknown> {
  if (cachedModelRuntime) return cachedModelRuntime;
  const mod = await import("@earendil-works/pi-coding-agent");
  const MR = (mod as Record<string, unknown>).ModelRuntime as {
    create: (opts?: Record<string, unknown>) => Promise<unknown>;
  };
  cachedModelRuntime = await MR.create();
  return cachedModelRuntime;
}

// Pi's llama.cpp provider ships as a built-in extension factory that only the
// CLI wires in (see pi's main(): [...builtInExtensions, ...]). The SDK's
// DefaultResourceLoader does NOT include it by default, so SDK consumers must
// pass it via resourceLoaderOptions.extensionFactories -- otherwise the
// llama.cpp provider is never registered and local models never appear.
// Resolved through the public getPackageDir() API (pinned to Pi 0.85.1);
// falls back to [] if the layout ever changes.
let cachedBuiltInFactories: unknown[] | undefined;
async function getBuiltInExtensionFactories(): Promise<unknown[]> {
  if (cachedBuiltInFactories) return cachedBuiltInFactories;
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
    const getPackageDir = mod.getPackageDir as () => string;
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const url = pathToFileURL(join(getPackageDir(), "dist", "extensions", "index.js")).href;
    const ext = (await import(url)) as { builtInExtensions?: unknown };
    cachedBuiltInFactories = Array.isArray(ext.builtInExtensions) ? (ext.builtInExtensions as unknown[]) : [];
  } catch {
    cachedBuiltInFactories = [];
  }
  return cachedBuiltInFactories;
}

function toModelInfo(m: { provider?: string; id?: string; name?: string; reasoning?: boolean; contextWindow?: number }): ModelInfo {
  return {
    provider: String(m.provider ?? "unknown"),
    id: String(m.id ?? "unknown"),
    name: m.name,
    reasoning: m.reasoning,
    contextWindow: m.contextWindow
  };
}

type PiSession = {
  prompt: (text: string, opts?: Record<string, unknown>) => Promise<void>;
  steer: (text: string) => Promise<void>;
  followUp: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  clearQueue: () => { steering: string[]; followUp: string[] };
  subscribe: (l: (e: Record<string, unknown>) => void) => () => void;
  dispose: () => void;
  setModel: (m: unknown, opts?: unknown) => Promise<void>;
  setThinkingLevel: (l: unknown, opts?: unknown) => void;
  setActiveToolsByName: (names: string[]) => void;
  getActiveToolNames: () => string[];
  getAllTools: () => { name: string }[];
  setSessionName: (n: string) => void;
  compact: (instructions?: string) => Promise<{ summary?: string }>;
  getSessionStats: () => { userMessages?: number; assistantMessages?: number; toolCalls?: number; totalMessages?: number };
  bindExtensions: (b: Record<string, unknown>) => Promise<void>;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  model?: { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number };
  thinkingLevel?: ThinkingLevel;
  messages?: { role?: string; content?: unknown; timestamp?: number }[];
  isStreaming?: boolean;
  isIdle?: boolean;
  resourceLoader?: {
    getSkills: () => { skills: { name: string; description?: string }[] };
    getPrompts: () => { prompts: { name: string; description?: string }[] };
  };
  extensionRunner?: { getRegisteredCommands: () => { name: string; description?: string }[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};

class RealChat implements ChatHandle {
  chatId: string;
  workspaceId: string;
  cwd: string;
  generation = 0;
  private runId = 0;
  private items: ChatItem[] = [];
  private runStatus: RunStatus = "idle";
  private queue: QueueState = { steering: [], followUp: [] };
  private model?: ModelInfo;
  private thinking: ThinkingLevel = "medium";
  private toolMode: ToolMode = "readonly";
  private sessionName?: string;
  private sessionFile: string | undefined;
  private listeners = new Set<(e: ServerEvent) => void>();
  private eventLog: { id: number; event: ServerEvent }[] = [];
  private nextEventId = 1;
  private disposed = false;
  private adapter: RealAdapter;
  private session: PiSession;
  private unsubscribe?: () => void;
  private pendingExtension = new Map<string, { resolve: (v: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void }>();
  private streamingAssistantId?: string;
  private streamingThinkingId?: string;
  private insideThink = false; // <think> splitter state for inline-reasoning models
  private textTail = ""; // holdback buffer for a possibly-split <think>/</think> tag
  private toolItems = new Map<string, string>(); // toolCallId -> itemId
  private settledForRun: (() => void)[] = [];

  constructor(adapter: RealAdapter, workspaceId: string, cwd: string, session: PiSession, initial: { items: ChatItem[]; model?: ModelInfo; thinking?: ThinkingLevel; toolMode?: ToolMode; name?: string }) {
    this.adapter = adapter;
    this.chatId = randomUUID();
    this.workspaceId = workspaceId;
    this.cwd = cwd;
    this.session = session;
    this.items = initial.items;
    if (initial.model) this.model = initial.model;
    else if (session.model) this.model = toModelInfo(session.model);
    if (initial.thinking) this.thinking = initial.thinking;
    else if (session.thinkingLevel) this.thinking = session.thinkingLevel as ThinkingLevel;
    if (initial.toolMode) this.toolMode = initial.toolMode;
    this.sessionName = initial.name ?? session.sessionName;
    this.sessionFile = session.sessionFile;
    this.attach();
    this.buildExtensionUi();
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  getSnapshot(): Snapshot {
    return {
      chatId: this.chatId,
      workspaceId: this.workspaceId,
      cwd: this.cwd,
      sessionId: this.sessionFile ? opaqueFromReal(this.sessionFile) : "",
      sessionName: this.sessionName ?? this.session.sessionName,
      model: this.model ?? (this.session.model ? toModelInfo(this.session.model) : undefined),
      thinking: (this.session.thinkingLevel as ThinkingLevel | undefined) ?? this.thinking,
      toolMode: this.toolMode,
      runStatus: this.runStatus,
      items: [...this.items],
      queue: { steering: [...this.queue.steering], followUp: [...this.queue.followUp] },
      commands: this.adapter.getCachedCommands(this.cwd),
      stats: this.tryStats()
    };
  }

  private tryStats() {
    try {
      const s = this.session.getSessionStats();
      return {
        userMessages: s.userMessages ?? 0,
        assistantMessages: s.assistantMessages ?? 0,
        toolCalls: s.toolCalls ?? 0,
        totalMessages: s.totalMessages ?? this.items.length
      };
    } catch {
      return {
        userMessages: this.items.filter((i) => i.kind === "user").length,
        assistantMessages: this.items.filter((i) => i.kind === "assistant").length,
        toolCalls: this.items.filter((i) => i.kind === "tool").length,
        totalMessages: this.items.length
      };
    }
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getEventsSince(lastId: number) {
    return { events: this.eventLog.filter((e) => e.id > lastId), nextId: this.nextEventId };
  }

  emit(event: ServerEvent): void {
    if (this.disposed) return;
    const id = this.nextEventId++;
    this.eventLog.push({ id, event });
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* ignore */
      }
    }
  }

  private setStatus(s: RunStatus): void {
    this.runStatus = s;
    this.emit({ type: "run_status", status: s });
  }

  private attach(): void {
    // Normalize SDK events into browser-safe union. Use agent_settled as primary settled signal.
    this.unsubscribe = this.session.subscribe((raw: Record<string, unknown>) => {
      if (this.disposed) return;
      const runId = this.runId;
      // stale-event rejection via generation/run: if disposed generation changed, ignore (disposed flag covers)
      void runId;
      if (DEBUG_EVENTS) logSdkEvent(raw);
      try {
        this.handleSdkEvent(raw);
      } catch (e) {
        this.emit({ type: "notice", text: `Event error: ${(e as Error).message}`, level: "error" });
      }
    });
  }

  private handleSdkEvent(ev: Record<string, unknown>): void {
    const type = ev.type as string;
    switch (type) {
      case "message_start": {
        // Lazy items: create the thinking/assistant items only when their first delta
        // arrives, so a model that emits no reasoning produces no empty "Thinking"
        // block, and ordering follows whichever content actually streams first.
        this.streamingThinkingId = undefined;
        this.streamingAssistantId = undefined;
        this.insideThink = false;
        this.textTail = "";
        break;
      }
      case "message_update": {
        const inner = ev.assistantMessageEvent as { type?: string; delta?: string; text?: string; thinking?: string } | undefined;
        if (!inner) break;
        const delta = typeof inner.delta === "string" ? inner.delta : typeof inner.text === "string" ? inner.text : undefined;
        if (inner.type === "text_delta" && typeof delta === "string") {
          // Route through the <think> splitter: structured-reasoning models emit no
          // tags (everything goes to the assistant item), while inline-reasoning local
          // models (QwQ, DeepSeek-R1, …) get their <think>…</think> content peeled off
          // into a dedicated thinking item instead of polluting the reply.
          this.feedAssistantText(delta);
        } else if (inner.type === "thinking_delta") {
          const d = typeof delta === "string" ? delta : typeof inner.thinking === "string" ? inner.thinking : "";
          if (d) this.appendThinking(d);
        }
        break;
      }
      case "message_end": {
        // Do NOT mark the run complete here (retries/compaction/queue may follow).
        // Flush any text the <think> splitter was holding back.
        this.flushTextTail();
        const msg = ev.message as { content?: unknown } | undefined;
        const content = msg?.content;
        // Fallback: if streaming produced no assistant/thinking item (some providers
        // deliver only the finalized message), materialise them from the completed
        // message — running text through the same splitter for inline reasoning.
        if (Array.isArray(content)) {
          const parts = content as { type?: string; text?: string; thinking?: string }[];
          const fullThinking = parts.filter((c) => c.type === "thinking").map((c) => c.thinking ?? "").join("");
          const fullText = parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
          if (!this.streamingThinkingId && fullThinking.trim()) this.appendThinking(fullThinking);
          if (!this.streamingAssistantId && fullText.trim()) {
            this.feedAssistantText(fullText);
            this.flushTextTail();
          }
        }
        break;
      }
      case "tool_execution_start": {
        // Field names vary by provider/version; read the documented names plus aliases.
        const tc = (ev.toolCall ?? {}) as Record<string, unknown>;
        const toolCallId = String(ev.toolCallId ?? ev.id ?? tc.id ?? newId("tool"));
        const toolName = String(ev.toolName ?? ev.name ?? tc.name ?? "tool");
        const rawArgs = ev.args ?? ev.input ?? ev.arguments ?? tc.input ?? tc.arguments;
        let argsSummary = toolName;
        try {
          const args = redactSecrets(rawArgs);
          if (args && typeof args === "object" && !Array.isArray(args)) {
            const keys = Object.entries(args as Record<string, unknown>)
              .slice(0, 3)
              .map(([k, v]) => `${k}: ${truncatePreview(typeof v === "string" ? v : JSON.stringify(v), 120)}`);
            argsSummary = `${toolName} { ${keys.join(", ")} }`.slice(0, 500);
          } else if (typeof args === "string" && args) {
            argsSummary = `${toolName} ${truncatePreview(args, 200)}`.slice(0, 500);
          }
        } catch {
          /* ignore */
        }
        const itemId = newId("tool");
        this.toolItems.set(toolCallId, itemId);
        const timestamp = Date.now();
        const item: ChatItem = { id: itemId, kind: "tool", toolName, argsSummary, status: "running", preview: "running…", timestamp };
        this.items.push(item);
        this.emit({ type: "tool_start", item: { id: itemId, kind: "tool", toolName, argsSummary, status: "running", preview: "running…", timestamp } });
        break;
      }
      case "tool_execution_update": {
        const tc = (ev.toolCall ?? {}) as Record<string, unknown>;
        const toolCallId = String(ev.toolCallId ?? ev.id ?? tc.id ?? "");
        const itemId = this.toolItems.get(toolCallId);
        if (!itemId) break;
        const it = this.items.find((i) => i.id === itemId);
        let preview = "running…";
        try {
          const text = extractContentText(ev.partialResult ?? ev.delta ?? ev.content ?? ev.output ?? ev.result);
          if (text) preview = truncatePreview(String(redactSecrets(text)).slice(0, 6000));
        } catch {
          /* ignore */
        }
        if (it && it.kind === "tool") {
          it.preview = preview;
          this.emit({ type: "tool_update", id: itemId, preview: preview.slice(0, 8000), status: "running" });
          this.emit({ type: "item_updated", item: { ...it } });
        }
        break;
      }
      case "tool_execution_end": {
        const tc = (ev.toolCall ?? {}) as Record<string, unknown>;
        const toolCallId = String(ev.toolCallId ?? ev.id ?? tc.id ?? "");
        const itemId = this.toolItems.get(toolCallId) ?? "";
        const isError = ev.isError === true || ev.error != null;
        let preview = "";
        try {
          const text = extractContentText(ev.result ?? ev.content ?? ev.output ?? ev.error);
          if (text) preview = truncatePreview(String(redactSecrets(text)).slice(0, 6000));
        } catch {
          /* ignore */
        }
        const it = this.items.find((i) => i.id === itemId);
        if (it && it.kind === "tool") {
          it.status = isError ? "error" : "success";
          it.preview = preview || (isError ? "[error]" : "[done]");
          this.emit({ type: "tool_end", id: itemId, status: it.status, preview: it.preview.slice(0, 8000) });
          this.emit({ type: "item_updated", item: { ...it } });
        }
        break;
      }
      case "queue_update": {
        const steering = Array.isArray(ev.steering) ? (ev.steering as string[]).map(String).slice(0, 20) : [];
        const followUp = Array.isArray(ev.followUp) ? (ev.followUp as string[]).map(String).slice(0, 20) : [];
        this.queue = { steering, followUp };
        this.emit({ type: "queue_update", steering, followUp });
        break;
      }
      case "compaction_start": {
        this.emit({ type: "notice", text: `Compaction started (${String(ev.reason ?? "manual")}).`, level: "info" });
        break;
      }
      case "compaction_end": {
        const aborted = ev.aborted === true;
        if (aborted) this.emit({ type: "notice", text: "Compaction aborted.", level: "warning" });
        else if (ev.result) this.emit({ type: "notice", text: "Compaction complete.", level: "info" });
        else this.emit({ type: "notice", text: `Compaction failed: ${truncatePreview(String(ev.errorMessage ?? "unknown"), 500)}`, level: "error" });
        // Refresh snapshot items from active branch after compaction
        void this.refreshFromSession();
        break;
      }
      case "auto_retry_start": {
        this.emit({ type: "notice", text: `Retrying (${String(ev.attempt ?? 1)}/${String(ev.maxAttempts ?? 3)}): ${truncatePreview(String(ev.errorMessage ?? ""), 500)}`, level: "warning" });
        break;
      }
      case "auto_retry_end": {
        if (ev.success === true) this.emit({ type: "notice", text: "Retry succeeded.", level: "info" });
        else this.emit({ type: "notice", text: `Retry failed: ${truncatePreview(String(ev.finalError ?? "unknown"), 500)}`, level: "error" });
        break;
      }
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished": {
        this.emit({ type: "notice", text: `Summarization retry: ${type}`, level: "info" });
        break;
      }
      case "extension_error": {
        this.emit({ type: "notice", text: `Extension error (${truncatePreview(String(ev.extensionPath ?? ""), 200)}): ${truncatePreview(String(ev.error ?? "unknown"), 500)}`, level: "error" });
        break;
      }
      case "agent_start": {
        if (this.runStatus === "idle") this.setStatus("running");
        break;
      }
      case "agent_end": {
        // Do NOT mark complete here; retries/compaction/queued may follow. Just record.
        break;
      }
      case "agent_settled": {
        // Session-level settled: authoritative completion.
        this.onSettled();
        break;
      }
      case "session_info_changed": {
        if (typeof ev.name === "string") {
          this.sessionName = ev.name;
          this.emit({ type: "session_meta", sessionName: ev.name });
        }
        break;
      }
      case "thinking_level_changed": {
        if (typeof ev.level === "string") {
          this.thinking = ev.level as ThinkingLevel;
          this.emit({ type: "session_meta", thinking: this.thinking });
        }
        break;
      }
      default:
        break;
    }
  }

  // Append streamed assistant text, lazily creating the assistant item on first delta.
  private appendAssistant(delta: string): void {
    if (!delta) return;
    let it = this.streamingAssistantId ? this.items.find((i) => i.id === this.streamingAssistantId) : undefined;
    if (!it || it.kind !== "assistant") {
      const created: ChatItem = { id: newId("a"), kind: "assistant", text: "", timestamp: Date.now(), completed: false };
      this.streamingAssistantId = created.id;
      this.items.push(created);
      this.emit({ type: "item_added", item: { ...created } });
      it = created;
    }
    if (it.kind !== "assistant") return;
    it.text += delta;
    this.emit({ type: "assistant_delta", messageId: it.id, delta: delta.slice(0, 8000) });
    this.emit({ type: "item_updated", item: { ...it } });
  }

  // Append streamed reasoning, lazily creating the thinking item on first delta.
  private appendThinking(delta: string): void {
    if (!delta) return;
    let it = this.streamingThinkingId ? this.items.find((i) => i.id === this.streamingThinkingId) : undefined;
    if (!it || it.kind !== "thinking") {
      const created: ChatItem = { id: newId("th"), kind: "thinking", text: "", timestamp: Date.now(), completed: false };
      this.streamingThinkingId = created.id;
      this.items.push(created);
      this.emit({ type: "item_added", item: { ...created } });
      it = created;
    }
    if (it.kind !== "thinking") return;
    it.text += delta;
    this.emit({ type: "thinking_delta", thinkingId: it.id, delta: delta.slice(0, 8000) });
    this.emit({ type: "item_updated", item: { ...it } });
  }

  // Split assistant text into reply vs inline <think>…</think> reasoning, buffering a
  // tail that could be a tag split across deltas.
  private feedAssistantText(chunk: string): void {
    const OPEN = "<think>";
    const CLOSE = "</think>";
    let buf = this.textTail + chunk;
    this.textTail = "";
    while (buf.length) {
      if (!this.insideThink) {
        const idx = buf.indexOf(OPEN);
        if (idx === -1) {
          const hold = partialTailLen(buf, OPEN);
          const emit = buf.slice(0, buf.length - hold);
          if (emit) this.appendAssistant(emit);
          this.textTail = buf.slice(buf.length - hold);
          return;
        }
        if (idx > 0) this.appendAssistant(buf.slice(0, idx));
        buf = buf.slice(idx + OPEN.length);
        this.insideThink = true;
      } else {
        const idx = buf.indexOf(CLOSE);
        if (idx === -1) {
          const hold = partialTailLen(buf, CLOSE);
          const emit = buf.slice(0, buf.length - hold);
          if (emit) this.appendThinking(emit);
          this.textTail = buf.slice(buf.length - hold);
          return;
        }
        if (idx > 0) this.appendThinking(buf.slice(0, idx));
        buf = buf.slice(idx + CLOSE.length);
        this.insideThink = false;
      }
    }
  }

  private flushTextTail(): void {
    if (!this.textTail) return;
    const rest = this.textTail;
    this.textTail = "";
    if (this.insideThink) this.appendThinking(rest);
    else this.appendAssistant(rest);
  }

  private onSettled(): void {
    // Flush any text the <think> splitter was holding back before completing.
    this.flushTextTail();
    this.insideThink = false;
    // Complete any streaming placeholders
    for (const it of this.items) {
      if ((it.kind === "assistant" || it.kind === "thinking") && !it.completed) {
        it.completed = true;
        if (it.kind === "assistant" && this.streamingAssistantId === it.id) this.emit({ type: "assistant_end", messageId: it.id });
        if (it.kind === "thinking" && this.streamingThinkingId === it.id) this.emit({ type: "thinking_end", thinkingId: it.id });
        this.emit({ type: "item_updated", item: { ...it } });
      }
    }
    this.streamingAssistantId = undefined;
    this.streamingThinkingId = undefined;
    // Refresh queue from session if available
    try {
      const s = this.session as unknown as { getSteeringMessages?: () => string[]; getFollowUpMessages?: () => string[] };
      if (s.getSteeringMessages && s.getFollowUpMessages) {
        this.queue = { steering: [...s.getSteeringMessages()], followUp: [...s.getFollowUpMessages()] };
        this.emit({ type: "queue_update", steering: this.queue.steering, followUp: this.queue.followUp });
      }
    } catch {
      /* ignore */
    }
    if (this.runStatus !== "idle") this.setStatus("idle");
    const cbs = this.settledForRun.splice(0);
    for (const cb of cbs) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  private async refreshFromSession(): Promise<void> {
    try {
      const items = RealAdapter.messagesToItems(this.session);
      // Merge by stable IDs when available; for real adapter, session messages lack stable web IDs,
      // so replace non-running tail? Simplest: replace all, preserving our tool preview bounds.
      this.items = items;
      // Re-emit snapshot so clients reconcile by IDs
      this.emit({ type: "snapshot", snapshot: this.getSnapshot() });
    } catch {
      /* ignore */
    }
  }

  private async buildExtensionUi(): Promise<void> {
    const uiContext = {
      select: async (title: string, options: string[]): Promise<string | undefined> => this.bridgeDialog("select", { title, options }),
      confirm: async (title: string, message: string): Promise<boolean> => {
        const v = await this.bridgeDialog("confirm", { title, message });
        return v === "__confirmed__";
      },
      input: async (title: string, placeholder?: string): Promise<string | undefined> => this.bridgeDialog("input", { title, placeholder }),
      editor: async (title: string, prefill?: string): Promise<string | undefined> => this.bridgeDialog("editor", { title, prefill }),
      notify: (message: string, type?: "info" | "warning" | "error"): void => {
        this.emit({ type: "extension_request", reqId: newId("ext"), method: "notify", message: truncatePreview(message, 2000), notifyType: type ?? "info", title: "notification" });
      },
      onTerminalInput: () => () => {},
      setStatus: (key: string, text: string | undefined): void => {
        this.emit({ type: "notice", text: text ? `[${key}] ${truncatePreview(text, 500)}` : `[${key}] cleared`, level: "info" });
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async (): Promise<undefined> => {
        this.emit({ type: "notice", text: "Custom TUI-only extension UI is not supported in the web UI.", level: "warning" });
        return undefined;
      },
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: {},
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false as const, error: "themes not supported in web UI" })
    };
    try {
      await this.session.bindExtensions({ uiContext, mode: "rpc" });
    } catch (e) {
      this.emit({ type: "notice", text: `Extension binding notice: ${(e as Error).message}`, level: "warning" });
    }
  }

  private bridgeDialog(
    method: "select" | "confirm" | "input" | "editor",
    opts: { title?: string; message?: string; options?: string[]; placeholder?: string; prefill?: string }
  ): Promise<string | undefined> {
    const reqId = newId("ext");
    this.emit({
      type: "extension_request",
      reqId,
      method,
      title: opts.title?.slice(0, 500),
      message: opts.message?.slice(0, 4000),
      options: opts.options?.slice(0, 30),
      placeholder: opts.placeholder?.slice(0, 500),
      prefill: opts.prefill?.slice(0, 8000)
    });
    return new Promise((resolve) => {
      this.pendingExtension.set(reqId, {
        resolve: (resp) => {
          this.emit({ type: "extension_resolved", reqId });
          if (resp.cancelled) return resolve(undefined);
          if (method === "confirm") return resolve(resp.confirmed ? "__confirmed__" : undefined);
          return resolve(resp.value);
        }
      });
      // Safety: never auto-confirm; auto-dismiss as cancelled after 5 min
      setTimeout(() => {
        if (this.pendingExtension.has(reqId)) {
          this.pendingExtension.delete(reqId);
          this.emit({ type: "extension_resolved", reqId });
          resolve(undefined);
        }
      }, 5 * 60_000).unref?.();
    });
  }

  async send(kind: "normal" | "steer" | "followUp", text: string): Promise<{ accepted: boolean; queued: boolean }> {
    if (this.disposed) throw Object.assign(new Error("chat disposed"), { code: "DISPOSED" });
    const trimmed = text.trim();
    if (!trimmed) throw Object.assign(new Error("empty message"), { code: "EMPTY" });
    const isBusy = this.runStatus !== "idle";
    if (!isBusy) {
      // Use preflight hook so HTTP can return 202 once accepted
      let preflightCb: ((ok: boolean) => void) | undefined;
      const preflight = new Promise<boolean>((resolve) => {
        const to = setTimeout(() => resolve(false), 2000);
        preflightCb = (ok: boolean) => {
          clearTimeout(to);
          resolve(ok);
        };
      });
      // Add user item optimistically (will be reconciled by session events)
      const userItem: ChatItem = { id: newId("u"), kind: "user", text: trimmed.slice(0, 20000), timestamp: Date.now() };
      this.items.push(userItem);
      this.emit({ type: "item_added", item: userItem });
      this.runId += 1;
      this.setStatus("running");
      const promptPromise = this.session.prompt(trimmed, {
        preflightResult: (ok: boolean) => preflightCb?.(ok)
      });
      // Attach settled fallback: prompt() resolves only after full accepted run
      void promptPromise
        .then(() => {
          // If agent_settled already fired, onSettled already ran; else settle now (fallback)
          if (this.runStatus !== "idle") this.onSettled();
        })
        .catch((e: Error) => {
          const msg = String(e?.message ?? e);
          const notice: ChatItem = { id: newId("n"), kind: "notice", text: `Run error: ${msg.slice(0, 1000)}`, level: "error", timestamp: Date.now() };
          this.items.push(notice);
          this.emit({ type: "item_added", item: notice });
          if (this.runStatus !== "idle") this.onSettled();
        });
      const ok = await preflight;
      return { accepted: ok !== false, queued: false };
    }
    // busy: steer / followUp
    if (kind === "steer") {
      await this.session.steer(trimmed);
      return { accepted: true, queued: true };
    }
    if (kind === "followUp") {
      await this.session.followUp(trimmed);
      return { accepted: true, queued: true };
    }
    throw Object.assign(new Error("agent is busy; use steer or followUp"), { code: "BUSY" });
  }

  async abort(): Promise<void> {
    if (this.runStatus === "idle") return;
    this.setStatus("stopping");
    try {
      try {
        this.session.clearQueue();
      } catch {
        /* queue clearing may not be supported; continue */
      }
      await this.session.abort();
    } catch {
      /* ignore abort errors; wait for settled */
    }
    // Remain Stopping until run settles (agent_settled or prompt promise fallback)
    // Safety timeout: force idle after 10s if SDK never settles
    setTimeout(() => {
      if (!this.disposed && this.runStatus === "stopping") this.onSettled();
    }, 10_000).unref?.();
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    try {
      const r = this.session.clearQueue();
      this.queue = { steering: [...(r.steering ?? [])], followUp: [...(r.followUp ?? [])] };
      // clearQueue returns removed items; our queue should now be empty in session, so emit empty
      this.emit({ type: "queue_update", steering: [], followUp: [] });
      this.queue = { steering: [], followUp: [] };
      return r;
    } catch {
      const prev = { ...this.queue };
      this.queue = { steering: [], followUp: [] };
      this.emit({ type: "queue_update", steering: [], followUp: [] });
      return prev;
    }
  }

  async setConfig(opts: { model?: { provider: string; id: string }; thinking?: ThinkingLevel; toolMode?: ToolMode }): Promise<void> {
    if (this.runStatus !== "idle") throw Object.assign(new Error("cannot change config while busy"), { code: "BUSY" });
    if (opts.model) {
      const rt = (await getModelRuntime()) as {
        getModel: (p: string, id: string) => unknown;
        getAvailable: () => Promise<unknown[]>;
      };
      const m = rt.getModel(opts.model.provider, opts.model.id);
      if (!m) throw Object.assign(new Error("model not found or not authenticated"), { code: "MODEL_NOT_FOUND" });
      await this.session.setModel(m);
      this.model = toModelInfo(m as { provider: string; id: string });
    }
    if (opts.thinking) {
      this.session.setThinkingLevel(opts.thinking);
      this.thinking = opts.thinking;
    }
    if (opts.toolMode) {
      const all = this.session.getAllTools().map((t) => t.name);
      if (opts.toolMode === "readonly") {
        const names = READONLY_TOOLS.filter((n) => all.includes(n));
        this.session.setActiveToolsByName(names.length ? names : all.slice(0, 4));
      } else {
        this.session.setActiveToolsByName(all);
      }
      this.toolMode = opts.toolMode;
    }
    this.emit({
      type: "session_meta",
      model: this.model,
      thinking: this.thinking,
      toolMode: this.toolMode,
      sessionName: this.sessionName
    });
  }

  async rename(name: string): Promise<void> {
    this.session.setSessionName(name.slice(0, 300));
    this.sessionName = name.slice(0, 300);
    this.emit({ type: "session_meta", sessionName: this.sessionName });
  }

  async compact(instructions?: string): Promise<{ summary: string }> {
    if (this.runStatus !== "idle") throw Object.assign(new Error("cannot compact while busy"), { code: "BUSY" });
    const r = await this.session.compact(instructions);
    return { summary: String(r.summary ?? "compacted") };
  }

  async respondToExtension(reqId: string, resp: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> {
    const p = this.pendingExtension.get(reqId);
    if (!p) throw Object.assign(new Error("unknown extension request"), { code: "NOT_FOUND" });
    this.pendingExtension.delete(reqId);
    p.resolve(resp);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    this.runId += 1;
    try {
      this.unsubscribe?.();
    } catch {
      /* ignore */
    }
    for (const [, p] of [...this.pendingExtension]) p.resolve({ cancelled: true });
    this.pendingExtension.clear();
    try {
      this.session.dispose();
    } catch {
      /* ignore */
    }
    this.adapter.release(this);
  }
}

export class RealAdapter implements PiAdapter {
  name: "real" = "real";
  private chats = new Map<string, RealChat>();
  private fileToChat = new Map<string, string>();
  private commandsCache = new Map<string, { name: string; description?: string; source: "extension" | "prompt" | "skill" }[]>();

  piVersion(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require("@earendil-works/pi-coding-agent/package.json") as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      return "0.85.1";
    }
  }

  getCachedCommands(cwd: string) {
    return this.commandsCache.get(cwd) ?? [];
  }

  toOpaqueSessionId(realPath: string): string {
    return opaqueFromReal(realPath);
  }

  async resolveSessionPath(cwd: string, opaqueSessionId: string): Promise<string> {
    let real: string;
    try {
      real = realFromOpaque(opaqueSessionId);
    } catch {
      throw Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION" });
    }
    // Validate against fresh Pi listing + session roots; block traversal/symlink escapes.
    const sessions = await this.listSessions(cwd);
    const allowed = new Set<string>();
    for (const s of sessions) {
      try {
        allowed.add(realpathSync(realFromOpaque(s.sessionId)));
      } catch {
        /* ignore */
      }
      try {
        allowed.add(realFromOpaque(s.sessionId));
      } catch {
        /* ignore */
      }
    }
    let rp: string;
    try {
      rp = realpathSync(real);
    } catch {
      throw Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION" });
    }
    if (!allowed.has(rp) && !allowed.has(real)) {
      // Also allow if under Pi session root (handles race where listing missed new file)
      const roots = await this.sessionRoots(cwd);
      const underRoot = roots.some((r) => rp === r || rp.startsWith(r + "/"));
      if (!underRoot) throw Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION" });
      if (!existsSync(rp)) throw Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION" });
    }
    return rp;
  }

  private async sessionRoots(cwd: string): Promise<string[]> {
    const mod = await import("@earendil-works/pi-coding-agent");
    const getAgentDir = (mod as Record<string, unknown>).getAgentDir as () => string;
    const agentDir = getAgentDir();
    const roots: string[] = [];
    try {
      roots.push(realpathSync(agentDir + "/sessions"));
    } catch {
      roots.push(agentDir + "/sessions");
    }
    const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (envDir) {
      try {
        roots.push(realpathSync(envDir));
      } catch {
        roots.push(envDir);
      }
    }
    // Custom sessionDir from settings
    try {
      const SM = (mod as Record<string, unknown>).SettingsManager as { create: (cwd: string, agentDir?: string) => { getSessionDir: () => string | undefined } };
      const sm = SM.create(cwd, agentDir);
      const custom = sm.getSessionDir();
      if (custom) {
        try {
          roots.push(realpathSync(custom));
        } catch {
          roots.push(custom);
        }
      }
    } catch {
      /* ignore */
    }
    void cwd;
    return roots;
  }

  private effectiveSessionDir(cwd: string, agentDir: string): string | undefined {
    if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
    return undefined;
  }

  async openWorkspace(cwd: string): Promise<WorkspaceData> {
    let rp: string;
    try {
      rp = realpathSync(cwd);
    } catch {
      throw Object.assign(new Error("workspace does not exist"), { code: "NO_WORKSPACE" });
    }
    if (!existsSync(rp) || !statSync(rp).isDirectory()) {
      throw Object.assign(new Error("workspace is not a directory"), { code: "NO_WORKSPACE" });
    }
    const mod = await import("@earendil-works/pi-coding-agent");
    const getAgentDir = (mod as Record<string, unknown>).getAgentDir as () => string;
    const agentDir = getAgentDir();
    // List models from a full services runtime (with built-in extensions such as
    // llama.cpp registered) so local/extension providers appear exactly as they
    // would for a new chat. A fresh runtime is used here so provider
    // registration never duplicates onto the shared singleton.
    let models: ModelInfo[] = [];
    const diagnostics: string[] = [`pi ${this.piVersion()}`, `cwd: ${rp}`];
    try {
      const { createAgentSessionServices, SettingsManager } = mod as unknown as {
        createAgentSessionServices: (o: Record<string, unknown>) => Promise<{
          modelRuntime: {
            getAvailable: () => Promise<{ provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }[]>;
          };
          diagnostics: { type: string; message: string }[];
        }>;
        SettingsManager: { create: (cwd: string, agentDir?: string) => unknown };
      };
      const smgr = SettingsManager.create(rp, agentDir);
      const extensionFactories = await getBuiltInExtensionFactories();
      const services = await createAgentSessionServices({
        cwd: rp,
        agentDir,
        settingsManager: smgr,
        resourceLoaderOptions: { extensionFactories }
      });
      const avail = await services.modelRuntime.getAvailable();
      models = avail.map(toModelInfo);
      for (const d of services.diagnostics) {
        if (d.type === "error") diagnostics.push(`setup: ${String(d.message).slice(0, 300)}`);
      }
    } catch {
      // Fall back to the shared runtime (built-in extension providers excluded).
      try {
        const modelRuntime = (await getModelRuntime()) as {
          getAvailable: () => Promise<{ provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }[]>;
        };
        models = (await modelRuntime.getAvailable()).map(toModelInfo);
      } catch {
        models = [];
      }
    }
    const sessions = await this.listSessions(rp);
    let trustNotice: string | undefined;
    try {
      const hasTrust = (mod as Record<string, unknown>).hasTrustRequiringProjectResources as ((cwd: string) => boolean) | undefined;
      const PTS = (mod as Record<string, unknown>).ProjectTrustStore as (new (agentDir: string) => { get: (cwd: string) => boolean | null }) | undefined;
      if (hasTrust && PTS && hasTrust(rp)) {
        const store = new PTS(agentDir);
        const decision = store.get(rp);
        if (decision === null || decision === undefined) {
          trustNotice = "Project-local resources were skipped pending trust. Approve trust by running `pi` in this project and choosing to trust it; the web UI never auto-approves trust.";
          diagnostics.push("trust: pending (protected resources skipped)");
        } else if (decision === false) {
          trustNotice = "Project trust is declined; project-local extensions/settings are skipped. The chat remains usable.";
        }
      }
    } catch {
      /* ignore trust diagnostics */
    }
    if (models.length === 0) {
      diagnostics.push("no authenticated models; run `pi` and `/login` locally");
    }
    return { cwd: rp, models, sessions, diagnostics, trustNotice, commands: this.getCachedCommands(rp) };
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const mod = await import("@earendil-works/pi-coding-agent");
    const SM = (mod as Record<string, unknown>).SessionManager as {
      list: (cwd: string, sessionDir?: string) => Promise<{ path: string; id: string; name?: string; cwd: string; created: Date; modified: Date; messageCount: number; firstMessage: string }[]>;
    };
    const getAgentDir = (mod as Record<string, unknown>).getAgentDir as () => string;
    const agentDir = getAgentDir();
    const sessionDir = this.effectiveSessionDir(cwd, agentDir);
    // Respect sessionDir setting when env not set
    let effective = sessionDir;
    if (!effective) {
      try {
        const SMgr = (mod as Record<string, unknown>).SettingsManager as { create: (cwd: string, agentDir?: string) => { getSessionDir: () => string | undefined } };
        effective = SMgr.create(cwd, agentDir).getSessionDir() ?? undefined;
      } catch {
        effective = undefined;
      }
    }
    const list = await SM.list(cwd, effective);
    return list.map((s) => ({
      sessionId: opaqueFromReal(s.path),
      name: s.name,
      cwd: s.cwd,
      created: new Date(s.created).getTime(),
      modified: new Date(s.modified).getTime(),
      messageCount: s.messageCount,
      firstMessage: String(s.firstMessage ?? "").slice(0, 500)
    }));
  }

  async createChat(workspaceId: string, cwd: string, name?: string): Promise<ChatHandle> {
    const mod = await import("@earendil-works/pi-coding-agent");
    const getAgentDir = (mod as Record<string, unknown>).getAgentDir as () => string;
    const agentDir = getAgentDir();
    const modelRuntime = await getModelRuntime();
    const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = mod as unknown as {
      createAgentSessionServices: (o: Record<string, unknown>) => Promise<{ diagnostics: { message: string }[]; [k: string]: unknown }>;
      createAgentSessionFromServices: (o: Record<string, unknown>) => Promise<{ session: PiSession }>;
      SessionManager: { create: (cwd: string, sessionDir?: string) => { getSessionFile?: () => string | undefined } & Record<string, unknown> };
      SettingsManager: { create: (cwd: string, agentDir?: string) => { getSessionDir: () => string | undefined } };
    };
    const smgr = SettingsManager.create(cwd, agentDir);
    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? smgr.getSessionDir() ?? undefined;
    const extensionFactories = await getBuiltInExtensionFactories();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: smgr,
      modelRuntime,
      resourceLoaderOptions: { extensionFactories }
    });
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const { session } = await createAgentSessionFromServices({ services, sessionManager, tools: [...READONLY_TOOLS] });
    if (name) {
      try {
        session.setSessionName(name);
      } catch {
        /* ignore */
      }
    }
    const real = session.sessionFile;
    if (!real) throw Object.assign(new Error("session has no file"), { code: "NO_SESSION_FILE" });
    // ownership check
    if (this.fileToChat.has(real)) throw Object.assign(new Error("session is already open in another chat"), { code: "CONFLICT" });
    const items = RealAdapter.messagesToItems(session);
    this.cacheCommands(cwd, session);
    const chat = new RealChat(this, workspaceId, cwd, session, { items, toolMode: "readonly", name });
    this.chats.set(chat.chatId, chat);
    this.fileToChat.set(real, chat.chatId);
    return chat;
  }

  async resumeChat(workspaceId: string, cwd: string, opaqueSessionId: string): Promise<ChatHandle> {
    const real = await this.resolveSessionPath(cwd, opaqueSessionId);
    // Single ownership: attach to existing live chat instead of opening a second writer.
    const existingId = this.fileToChat.get(real);
    if (existingId) {
      const existing = this.chats.get(existingId);
      if (existing) {
        existing.workspaceId = workspaceId;
        existing.cwd = cwd;
        return existing;
      } else {
        this.fileToChat.delete(real);
      }
    }
    const mod = await import("@earendil-works/pi-coding-agent");
    const getAgentDir = (mod as Record<string, unknown>).getAgentDir as () => string;
    const agentDir = getAgentDir();
    const modelRuntime = await getModelRuntime();
    const { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = mod as unknown as {
      createAgentSessionServices: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
      createAgentSessionFromServices: (o: Record<string, unknown>) => Promise<{ session: PiSession }>;
      SessionManager: { open: (path: string, sessionDir?: string) => Record<string, unknown> };
      SettingsManager: { create: (cwd: string, agentDir?: string) => { getSessionDir: () => string | undefined } };
    };
    const smgr = SettingsManager.create(cwd, agentDir);
    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? smgr.getSessionDir() ?? undefined;
    const extensionFactories = await getBuiltInExtensionFactories();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: smgr,
      modelRuntime,
      resourceLoaderOptions: { extensionFactories }
    });
    // Resume only exact session paths returned by Pi's own listing APIs (validated above)
    const sessionManager = SessionManager.open(real, sessionDir);
    const { session } = await createAgentSessionFromServices({ services, sessionManager });
    // Rebuild snapshot through active-branch API
    const items = await this.buildActiveBranchItems(sessionManager, session);
    this.cacheCommands(cwd, session);
    const chat = new RealChat(this, workspaceId, cwd, session, { items, toolMode: "readonly" });
    this.chats.set(chat.chatId, chat);
    this.fileToChat.set(real, chat.chatId);
    return chat;
  }

  private async buildActiveBranchItems(sessionManager: unknown, session: PiSession): Promise<ChatItem[]> {
    try {
      const sm = sessionManager as { buildContextEntries: () => { type: string; id: string; message?: { role?: string; content?: unknown }; timestamp?: string }[] };
      if (typeof sm.buildContextEntries === "function") {
        const entries = sm.buildContextEntries();
        // Convert active-branch entries to items (not flattening abandoned branches)
        const items: ChatItem[] = [];
        for (const e of entries) {
          if (e.type === "message" && e.message) {
            const role = (e.message as { role?: string }).role;
            const content = (e.message as { content?: unknown }).content;
            const ts = Date.parse(e.timestamp ?? "") || Date.now();
            if (role === "user") {
              items.push({ id: `e-${e.id}`, kind: "user", text: truncatePreview(RealAdapter.contentToText(content), 20000), timestamp: ts });
            } else if (role === "assistant") {
              // Restore reasoning + tool calls too (including inline <think>), not just text.
              items.push(...RealAdapter.assistantContentToItems(content, ts, `e-${e.id}`));
            }
          } else if (e.type === "compaction") {
            items.push({ id: `e-${e.id}`, kind: "notice", text: "Context compacted (history summarized).", level: "info", timestamp: Date.parse(e.timestamp ?? "") || Date.now() });
          }
        }
        if (items.length) return items;
      }
    } catch {
      /* fall through to messages */
    }
    return RealAdapter.messagesToItems(session);
  }

  static contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (!c || typeof c !== "object") return "";
          const o = c as Record<string, unknown>;
          if (o.type === "text" && typeof o.text === "string") return o.text;
          if (o.type === "thinking" && typeof o.thinking === "string") return "";
          if (o.type === "toolCall") return "";
          return "";
        })
        .join("");
    }
    return "";
  }

  // Peel inline <think>…</think> reasoning out of a stored assistant text so a
  // resumed local-model session shows the reasoning in its own block, not the reply.
  static splitInlineThink(text: string): { thinking: string; reply: string } {
    if (!text.includes("<think>")) return { thinking: "", reply: text };
    let thinking = "";
    let reply = "";
    let last = 0;
    const re = /<think>([\s\S]*?)<\/think>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      reply += text.slice(last, m.index);
      thinking += m[1];
      last = re.lastIndex;
    }
    reply += text.slice(last);
    // Unterminated <think> (e.g. an interrupted run): treat the remainder as reasoning.
    const open = reply.indexOf("<think>");
    if (open !== -1) {
      thinking += reply.slice(open + "<think>".length);
      reply = reply.slice(0, open);
    }
    return { thinking: thinking.trim(), reply: reply.trim() };
  }

  // Convert one stored assistant message's content into ordered thinking/text/tool
  // items with deterministic ids (so resnapshots reconcile instead of duplicating).
  static assistantContentToItems(content: unknown, timestamp: number, idPrefix: string): ChatItem[] {
    const out: ChatItem[] = [];
    let text = "";
    let thinking = "";
    const tools: { name: string; args: unknown }[] = [];
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const c of content as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }[]) {
        if (c.type === "text" && c.text) text += c.text;
        else if (c.type === "thinking" && c.thinking) thinking += c.thinking;
        else if (c.type === "toolCall") tools.push({ name: String(c.name ?? "tool"), args: c.arguments });
      }
    }
    if (!thinking && text.includes("<think>")) {
      const s = RealAdapter.splitInlineThink(text);
      thinking = s.thinking;
      text = s.reply;
    }
    let n = 0;
    if (thinking.trim()) out.push({ id: `${idPrefix}-th${n++}`, kind: "thinking", text: truncatePreview(thinking, 20000), timestamp, completed: true });
    if (text.trim()) out.push({ id: `${idPrefix}-a${n++}`, kind: "assistant", text: truncatePreview(text, 20000), timestamp, completed: true });
    for (const t of tools) {
      out.push({
        id: `${idPrefix}-tool${n++}`,
        kind: "tool",
        toolName: t.name,
        argsSummary: truncatePreview(`${t.name} ${JSON.stringify(redactSecrets(t.args) ?? {}).slice(0, 300)}`, 500),
        status: "success",
        preview: "[tool call]",
        timestamp
      });
    }
    return out;
  }

  static messagesToItems(session: PiSession): ChatItem[] {
    const out: ChatItem[] = [];
    const msgs = session.messages ?? [];
    for (const m of msgs) {
      const role = m.role;
      if (role === "user") {
        const text = typeof m.content === "string" ? m.content : RealAdapter.contentToText(m.content);
        out.push({ id: newId("u"), kind: "user", text: truncatePreview(text, 20000), timestamp: m.timestamp ?? Date.now() });
      } else if (role === "assistant") {
        out.push(...RealAdapter.assistantContentToItems(m.content, m.timestamp ?? Date.now(), newId("m")));
      } else if (role === "toolResult") {
        const tr = m as unknown as { toolCallId?: string; toolName?: string; content?: { text?: string }[] | string; isError?: boolean };
        let preview = "";
        if (typeof tr.content === "string") preview = tr.content;
        else if (Array.isArray(tr.content)) preview = tr.content.map((c) => c.text ?? "").join("\n");
        out.push({
          id: newId("tool"),
          kind: "tool",
          toolName: String(tr.toolName ?? "tool"),
          argsSummary: String(tr.toolName ?? "tool"),
          status: tr.isError ? "error" : "success",
          preview: truncatePreview(preview || "[tool result]", 4000),
          timestamp: (m as { timestamp?: number }).timestamp ?? Date.now()
        });
      }
    }
    return out;
  }

  private cacheCommands(cwd: string, session: PiSession): void {
    try {
      const cmds: { name: string; description?: string; source: "extension" | "prompt" | "skill" }[] = [];
      const runner = session.extensionRunner;
      if (runner?.getRegisteredCommands) {
        for (const c of runner.getRegisteredCommands()) cmds.push({ name: c.name, description: c.description, source: "extension" });
      }
      const rl = session.resourceLoader;
      if (rl?.getPrompts) {
        for (const p of rl.getPrompts().prompts ?? []) cmds.push({ name: p.name, description: p.description, source: "prompt" });
      }
      if (rl?.getSkills) {
        for (const s of rl.getSkills().skills ?? []) cmds.push({ name: `skill:${s.name}`, description: s.description, source: "skill" });
      }
      this.commandsCache.set(cwd, cmds.slice(0, 100));
    } catch {
      /* ignore */
    }
  }

  getChat(chatId: string): ChatHandle | undefined {
    return this.chats.get(chatId);
  }

  release(chat: RealChat): void {
    this.chats.delete(chat.chatId);
    const f = chat.getSessionFile();
    if (f && this.fileToChat.get(f) === chat.chatId) this.fileToChat.delete(f);
  }
}
