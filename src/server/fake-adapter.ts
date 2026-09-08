import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { ChatHandle, PiAdapter, WorkspaceData } from "./adapter.js";
import {
  truncatePreview,
  type ChatItem,
  type ExtensionCommand,
  type ModelInfo,
  type QueueState,
  type RunStatus,
  type ServerEvent,
  type SessionSummary,
  type Snapshot,
  type ThinkingLevel,
  type ToolMode
} from "../shared/protocol.js";

const FAKE_MODELS: ModelInfo[] = [
  { provider: "fake", id: "fake-small", name: "Fake Small", reasoning: false, contextWindow: 32000 },
  { provider: "fake", id: "fake-large", name: "Fake Large", reasoning: true, contextWindow: 200000 }
];

const FAKE_COMMANDS: ExtensionCommand[] = [
  { name: "demo-confirm", description: "Demo extension confirm dialog", source: "extension" },
  { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
  { name: "skill:brave-search", description: "Web search", source: "skill" }
];

function fakeRoot(): string {
  const dir = join(tmpdir(), "pi-webui-fake-sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function cwdKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function sessionDirFor(cwd: string): string {
  const dir = join(fakeRoot(), cwdKey(cwd));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

interface PersistedSession {
  id: string;
  name?: string;
  cwd: string;
  created: number;
  modified: number;
  items: ChatItem[];
  model?: ModelInfo;
  thinking?: ThinkingLevel;
  toolMode?: ToolMode;
}

function realPathFor(cwd: string, id: string): string {
  return join(sessionDirFor(cwd), `${id}.jsonl`);
}

function opaqueFromReal(realPath: string): string {
  return Buffer.from(realPath, "utf8").toString("base64url");
}

function realFromOpaque(opaque: string): string {
  const s = Buffer.from(opaque, "base64url").toString("utf8");
  if (!s || s.includes("\0")) throw new Error("bad opaque id");
  return s;
}

function loadPersisted(realPath: string): PersistedSession | undefined {
  try {
    if (!existsSync(realPath)) return undefined;
    const raw = readFileSync(realPath, "utf8");
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return undefined;
  }
}

function savePersisted(realPath: string, data: PersistedSession): void {
  writeFileSync(realPath, JSON.stringify(data), "utf8");
}

let itemCounter = 0;
function newId(prefix: string): string {
  itemCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${itemCounter}-${randomUUID().slice(0, 6)}`;
}

class FakeChat implements ChatHandle {
  chatId: string;
  workspaceId: string;
  cwd: string;
  generation = 0;
  private runId = 0;
  private items: ChatItem[] = [];
  private runStatus: RunStatus = "idle";
  private queue: QueueState = { steering: [], followUp: [] };
  private model: ModelInfo = FAKE_MODELS[1]!;
  private thinking: ThinkingLevel = "medium";
  private toolMode: ToolMode = "readonly";
  private sessionName?: string;
  private sessionFile: string | undefined;
  private listeners = new Set<(e: ServerEvent) => void>();
  private eventLog: { id: number; event: ServerEvent }[] = [];
  private nextEventId = 1;
  private timers: NodeJS.Timeout[] = [];
  private pendingExtension = new Map<
    string,
    { resolve: (v: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void; method: string }
  >();
  private disposed = false;
  private adapter: FakeAdapter;
  private compactionCount = 0;

  constructor(adapter: FakeAdapter, workspaceId: string, cwd: string, persisted: PersistedSession, sessionFile: string) {
    this.adapter = adapter;
    this.chatId = randomUUID();
    this.workspaceId = workspaceId;
    this.cwd = cwd;
    this.items = [...persisted.items];
    this.model = persisted.model ?? FAKE_MODELS[1]!;
    this.thinking = persisted.thinking ?? "medium";
    this.toolMode = persisted.toolMode ?? "readonly";
    this.sessionName = persisted.name;
    this.sessionFile = sessionFile;
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
      sessionName: this.sessionName,
      model: this.model,
      thinking: this.thinking,
      toolMode: this.toolMode,
      runStatus: this.runStatus,
      items: [...this.items],
      queue: { steering: [...this.queue.steering], followUp: [...this.queue.followUp] },
      commands: FAKE_COMMANDS,
      stats: {
        userMessages: this.items.filter((i) => i.kind === "user").length,
        assistantMessages: this.items.filter((i) => i.kind === "assistant").length,
        toolCalls: this.items.filter((i) => i.kind === "tool").length,
        totalMessages: this.items.length
      }
    };
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getEventsSince(lastId: number): { events: { id: number; event: ServerEvent }[]; nextId: number } {
    const events = this.eventLog.filter((e) => e.id > lastId);
    return { events, nextId: this.nextEventId };
  }

  private emit(event: ServerEvent): void {
    if (this.disposed) return;
    const id = this.nextEventId++;
    this.eventLog.push({ id, event });
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // ignore listener errors
      }
    }
    // Persist snapshot-relevant state on settled changes
    if (event.type === "snapshot" || event.type === "run_status" || event.type === "session_meta") {
      this.persist();
    }
  }

  // Public emit for ChatManager to push into SSE buffer with IDs
  emitForSse(event: ServerEvent): void {
    this.emit(event);
  }

  private persist(): void {
    if (!this.sessionFile) return;
    const now = Date.now();
    const existing = loadPersisted(this.sessionFile);
    const data: PersistedSession = {
      id: existing?.id ?? basename(this.sessionFile, ".jsonl"),
      name: this.sessionName,
      cwd: this.cwd,
      created: existing?.created ?? now,
      modified: now,
      items: this.items,
      model: this.model,
      thinking: this.thinking,
      toolMode: this.toolMode
    };
    try {
      savePersisted(this.sessionFile, data);
    } catch {
      // ignore
    }
  }

  private later(ms: number, fn: () => void, runId: number): void {
    const t = setTimeout(() => {
      // stale-event rejection: ignore if generation changed or run superseded or disposed
      if (this.disposed) return;
      if (runId !== this.runId) return;
      fn();
    }, ms);
    this.timers.push(t);
  }

  async send(kind: "normal" | "steer" | "followUp", text: string): Promise<{ accepted: boolean; queued: boolean }> {
    if (this.disposed) throw Object.assign(new Error("chat disposed"), { code: "DISPOSED" });
    const trimmed = text.trim();
    if (!trimmed) throw Object.assign(new Error("empty message"), { code: "EMPTY" });
    if (this.runStatus !== "idle") {
      if (kind === "steer") {
        this.queue.steering.push(trimmed);
        this.emit({ type: "queue_update", steering: [...this.queue.steering], followUp: [...this.queue.followUp] });
        return { accepted: true, queued: true };
      }
      if (kind === "followUp") {
        this.queue.followUp.push(trimmed);
        this.emit({ type: "queue_update", steering: [...this.queue.steering], followUp: [...this.queue.followUp] });
        return { accepted: true, queued: true };
      }
      // normal while busy -> treat as followUp? Spec says idle send uses prompt; while busy Steer/Follow-up. Reject normal while busy.
      throw Object.assign(new Error("agent is busy; use steer or followUp"), { code: "BUSY" });
    }
    // idle: start run
    const userItem: ChatItem = { id: newId("u"), kind: "user", text: truncatePreview(trimmed, 8000), timestamp: Date.now() };
    this.items.push(userItem);
    this.emit({ type: "item_added", item: userItem });
    this.startRun(trimmed);
    return { accepted: true, queued: false };
  }

  private startRun(promptText: string): void {
    this.runId += 1;
    const runId = this.runId;
    this.runStatus = "running";
    this.emit({ type: "run_status", status: "running" });

    // Extension dialog demo: /demo-confirm triggers a confirm flow
    if (promptText.trim() === "/demo-confirm" || promptText.includes("[demo-confirm]")) {
      const reqId = newId("ext");
      this.later(
        15,
        () => {
          this.emit({
            type: "extension_request",
            reqId,
            method: "confirm",
            title: "Demo confirm",
            message: "Allow demo action?"
          });
          // Wait for response via pendingExtension
          new Promise<{ value?: string; confirmed?: boolean; cancelled?: boolean }>((resolve) => {
            this.pendingExtension.set(reqId, { resolve, method: "confirm" });
            // auto-fallback timeout safety: resolve as cancelled after 60s (never auto-confirm)
            const to = setTimeout(() => {
              if (this.pendingExtension.has(reqId)) {
                this.pendingExtension.delete(reqId);
                resolve({ cancelled: true });
              }
            }, 60_000);
            // clear timeout on resolve
            const orig = resolve;
            this.pendingExtension.set(reqId, {
              resolve: (v) => {
                clearTimeout(to);
                orig(v);
              },
              method: "confirm"
            });
          }).then((resp) => {
            if (runId !== this.runId || this.disposed) return;
            const ok = resp.confirmed === true && !resp.cancelled;
            const notice: ChatItem = {
              id: newId("n"),
              kind: "notice",
              text: ok ? "Confirmed demo action." : "Demo action dismissed (cancelled).",
              level: ok ? "info" : "warning",
              timestamp: Date.now()
            };
            this.items.push(notice);
            this.emit({ type: "item_added", item: notice });
            this.emit({ type: "extension_resolved", reqId });
            this.finishRun(runId, `Done (confirm ${ok ? "accepted" : "dismissed"}).`);
          });
        },
        runId
      );
      return;
    }

    // Normal simulated run: thinking + assistant deltas + optional tool
    const thinkingId = newId("th");
    const thinkingItem: ChatItem = { id: thinkingId, kind: "thinking", text: "", timestamp: Date.now(), completed: false };
    const messageId = newId("a");
    const assistantItem: ChatItem = { id: messageId, kind: "assistant", text: "", timestamp: Date.now(), completed: false };

    const wantsTool = /tool|read|ls|grep|bash/i.test(promptText) || promptText.includes("[tool]");
    const fullText = this.buildReply(promptText, wantsTool);

    this.later(10, () => {
      this.items.push(thinkingItem);
      this.emit({ type: "item_added", item: { ...thinkingItem } });
    }, runId);

    this.later(20, () => {
      const delta = "Thinking: considering request…";
      const it = this.items.find((i) => i.id === thinkingId);
      if (it && it.kind === "thinking") {
        it.text += delta;
        this.emit({ type: "thinking_delta", thinkingId, delta });
        this.emit({ type: "item_updated", item: { ...it } });
      }
    }, runId);

    this.later(30, () => {
      const it = this.items.find((i) => i.id === thinkingId);
      if (it && it.kind === "thinking") {
        it.completed = true;
        this.emit({ type: "thinking_end", thinkingId });
        this.emit({ type: "item_updated", item: { ...it } });
      }
      this.items.push(assistantItem);
      this.emit({ type: "item_added", item: { ...assistantItem } });
    }, runId);

    // stream text in 3 chunks
    const chunks = chunkText(fullText, 3);
    chunks.forEach((c, idx) => {
      this.later(40 + idx * 15, () => {
        const it = this.items.find((i) => i.id === messageId);
        if (it && it.kind === "assistant") {
          it.text += c;
          this.emit({ type: "assistant_delta", messageId, delta: c });
          this.emit({ type: "item_updated", item: { ...it } });
        }
      }, runId);
    });

    if (wantsTool) {
      const toolId = newId("tool");
      this.later(50, () => {
        const toolItem: ChatItem = {
          id: toolId,
          kind: "tool",
          toolName: "read",
          argsSummary: "read { path: \"example.txt\" }",
          status: "running",
          preview: "reading…",
          timestamp: Date.now()
        };
        this.items.push(toolItem);
        this.emit({
          type: "tool_start",
          item: { id: toolId, kind: "tool", toolName: "read", argsSummary: toolItem.argsSummary, status: "running", preview: "reading…", timestamp: toolItem.timestamp }
        });
      }, runId);
      this.later(70, () => {
        const it = this.items.find((i) => i.id === toolId);
        const preview = truncatePreview("line1: hello\nline2: world\nline3: fake tool output");
        if (it && it.kind === "tool") {
          it.preview = preview;
          this.emit({ type: "tool_update", id: toolId, preview, status: "running" });
          this.emit({ type: "item_updated", item: { ...it } });
        }
      }, runId);
      this.later(90, () => {
        const it = this.items.find((i) => i.id === toolId);
        const preview = truncatePreview("line1: hello\nline2: world");
        if (it && it.kind === "tool") {
          it.status = "success";
          it.preview = preview;
          this.emit({ type: "tool_end", id: toolId, status: "success", preview });
          this.emit({ type: "item_updated", item: { ...it } });
        }
      }, runId);
      this.later(110, () => this.finishRun(runId, undefined, messageId), runId);
    } else {
      this.later(90, () => this.finishRun(runId, undefined, messageId), runId);
    }
  }

  private buildReply(promptText: string, wantsTool: boolean): string {
    // Deterministic, no tokens spent. Include markdown to exercise renderer.
    let base = `Echo: ${promptText.slice(0, 500)}\n\nThis is a **fake** assistant reply with _markdown_.\n\n- item one\n- item two\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n[docs](https://example.com)`;
    if (wantsTool) base += `\n\nUsed \`read\` tool (see tool activity).`;
    if (/fail|error/i.test(promptText)) base += `\n\n> Note: prompt contained error keyword, but fake run still succeeds.`;
    return base;
  }

  private finishRun(runId: number, appendText?: string, messageId?: string): void {
    if (runId !== this.runId || this.disposed) return;
    if (appendText && messageId) {
      // not used; for confirm path we create new assistant message
    }
    if (appendText) {
      const m: ChatItem = { id: newId("a"), kind: "assistant", text: appendText, timestamp: Date.now(), completed: true };
      this.items.push(m);
      this.emit({ type: "item_added", item: m });
      this.emit({ type: "assistant_end", messageId: m.id });
    } else if (messageId) {
      const it = this.items.find((i) => i.id === messageId);
      if (it && it.kind === "assistant") {
        it.completed = true;
        this.emit({ type: "assistant_end", messageId });
        this.emit({ type: "item_updated", item: { ...it } });
      }
    }
    // process queued messages one at a time (steer first, then followUp one)
    const nextSteer = this.queue.steering.shift();
    const nextFollow = nextSteer ? undefined : this.queue.followUp.shift();
    const next = nextSteer ?? nextFollow;
    if (nextSteer || nextFollow) {
      this.emit({ type: "queue_update", steering: [...this.queue.steering], followUp: [...this.queue.followUp] });
    }
    if (next) {
      const userItem: ChatItem = { id: newId("u"), kind: "user", text: next, timestamp: Date.now() };
      this.items.push(userItem);
      this.emit({ type: "item_added", item: userItem });
      // keep running, start next run without going idle (tests queue/settled behavior)
      this.persist();
      this.startRun(next);
      return;
    }
    this.runStatus = "idle";
    this.emit({ type: "run_status", status: "idle" });
    this.persist();
  }

  async abort(): Promise<void> {
    if (this.runStatus === "idle") return;
    this.runStatus = "stopping";
    this.emit({ type: "run_status", status: "stopping" });
    // increment runId to invalidate pending timers (stale-event rejection)
    this.runId += 1;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    // clear queued when supported (fake supports)
    const hadQueue = this.queue.steering.length + this.queue.followUp.length > 0;
    this.queue = { steering: [], followUp: [] };
    if (hadQueue) this.emit({ type: "queue_update", steering: [], followUp: [] });
    // cancel pending extension dialogs
    for (const [reqId, p] of [...this.pendingExtension]) {
      p.resolve({ cancelled: true });
      this.pendingExtension.delete(reqId);
      this.emit({ type: "extension_resolved", reqId });
    }
    const notice: ChatItem = { id: newId("n"), kind: "notice", text: "Run stopped by user.", level: "warning", timestamp: Date.now() };
    this.items.push(notice);
    this.emit({ type: "item_added", item: notice });
    // mark any incomplete assistant/thinking as completed
    for (const it of this.items) {
      if ((it.kind === "assistant" || it.kind === "thinking") && !it.completed) {
        it.completed = true;
        this.emit({ type: "item_updated", item: { ...it } });
      }
      if (it.kind === "tool" && it.status === "running") {
        it.status = "error";
        it.preview = truncatePreview((it.preview || "") + "\n[cancelled]");
        this.emit({ type: "tool_end", id: it.id, status: "error", preview: it.preview });
        this.emit({ type: "item_updated", item: { ...it } });
      }
    }
    // remain Stopping briefly until settled
    const runId = this.runId;
    setTimeout(() => {
      if (this.disposed) return;
      if (runId !== this.runId) return;
      this.runStatus = "idle";
      this.emit({ type: "run_status", status: "idle" });
      this.persist();
    }, 25);
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const prev = { steering: [...this.queue.steering], followUp: [...this.queue.followUp] };
    this.queue = { steering: [], followUp: [] };
    this.emit({ type: "queue_update", steering: [], followUp: [] });
    return prev;
  }

  async setConfig(opts: { model?: { provider: string; id: string }; thinking?: ThinkingLevel; toolMode?: ToolMode }): Promise<void> {
    if (this.runStatus !== "idle") throw Object.assign(new Error("cannot change config while busy"), { code: "BUSY" });
    if (opts.model) {
      const found = FAKE_MODELS.find((m) => m.provider === opts.model!.provider && m.id === opts.model!.id);
      if (!found) throw Object.assign(new Error("model not found"), { code: "MODEL_NOT_FOUND" });
      this.model = found;
    }
    if (opts.thinking) this.thinking = opts.thinking;
    if (opts.toolMode) this.toolMode = opts.toolMode;
    this.emit({
      type: "session_meta",
      model: this.model,
      thinking: this.thinking,
      toolMode: this.toolMode,
      sessionName: this.sessionName
    });
    this.persist();
  }

  async rename(name: string): Promise<void> {
    this.sessionName = name.slice(0, 300);
    this.emit({ type: "session_meta", sessionName: this.sessionName });
    this.persist();
  }

  async compact(instructions?: string): Promise<{ summary: string }> {
    if (this.runStatus !== "idle") throw Object.assign(new Error("cannot compact while busy"), { code: "BUSY" });
    this.emit({ type: "notice", text: "Compaction started (fake).", level: "info" });
    // Simulate compaction: keep last 4 items + insert notice summarizing older
    const keep = this.items.slice(-4);
    const dropped = this.items.length - keep.length;
    this.compactionCount += 1;
    const summary = `Compacted ${dropped} items${instructions ? ` with focus: ${instructions.slice(0, 200)}` : ""}. (fake compaction #${this.compactionCount})`;
    const notice: ChatItem = { id: newId("n"), kind: "notice", text: summary, level: "info", timestamp: Date.now() };
    this.items = [...keep, notice];
    this.emit({ type: "item_added", item: notice });
    this.emit({ type: "notice", text: "Compaction complete.", level: "info" });
    this.persist();
    return { summary };
  }

  async respondToExtension(reqId: string, resp: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> {
    const pending = this.pendingExtension.get(reqId);
    if (!pending) throw Object.assign(new Error("unknown extension request"), { code: "NOT_FOUND" });
    this.pendingExtension.delete(reqId);
    pending.resolve(resp);
  }

  // Test helper: emit a bounded large tool preview
  emitLargeToolPreviewForTest(size: number): string {
    const big = "x".repeat(size);
    const preview = truncatePreview(big);
    const toolItem: ChatItem = {
      id: newId("tool"),
      kind: "tool",
      toolName: "read",
      argsSummary: "read { path: \"big.txt\" }",
      status: "success",
      preview,
      timestamp: Date.now()
    };
    this.items.push(toolItem);
    this.emit({ type: "item_added", item: toolItem });
    return preview;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    this.runId += 1;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    for (const [reqId, p] of [...this.pendingExtension]) {
      p.resolve({ cancelled: true });
      this.pendingExtension.delete(reqId);
    }
    this.listeners.clear();
    this.persist();
    this.adapter.release(this);
  }

  // Simulate an extension notify (fire-and-forget) for tests
  notifyForTest(message: string): void {
    this.emit({ type: "extension_request", reqId: newId("ext"), method: "notify", message, notifyType: "info", title: "notify" });
  }
}

function chunkText(s: string, n: number): string[] {
  if (n <= 1) return [s];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export class FakeAdapter implements PiAdapter {
  name: "fake" = "fake";
  private chats = new Map<string, FakeChat>();
  private fileToChat = new Map<string, string>();

  piVersion(): string {
    return "0.85.1-fake";
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
    // Validate against fresh listing + session roots; block traversal/symlink escapes.
    const sessions = await this.listSessions(cwd);
    const allowed = new Set(sessions.map((s) => s.sessionId).map((op) => {
      try {
        return realFromOpaque(op);
      } catch {
        return "";
      }
    }));
    // Also allow direct real path check via fs realpath containment
    const { realpathSync, existsSync } = await import("node:fs");
    try {
      const rp = realpathSync(real);
      const dir = sessionDirFor(cwd);
      const rdir = realpathSync(dir);
      if (!rp.startsWith(rdir + "/") && rp !== rdir) throw new Error("outside session root");
      if (!allowed.has(real) && !allowed.has(rp)) {
        // If file exists but not in listing (race), still require it be under session dir
        if (!existsSync(rp)) throw new Error("unknown session");
      }
      return rp;
    } catch (e: unknown) {
      const err = e as Error & { code?: string };
      if (err.code === "INVALID_SESSION") throw err;
      throw Object.assign(new Error("invalid session id"), { code: "INVALID_SESSION" });
    }
  }

  async openWorkspace(cwd: string): Promise<WorkspaceData> {
    const { realpathSync, existsSync, statSync } = await import("node:fs");
    let rp: string;
    try {
      rp = realpathSync(cwd);
    } catch {
      throw Object.assign(new Error("workspace does not exist"), { code: "NO_WORKSPACE" });
    }
    if (!existsSync(rp) || !statSync(rp).isDirectory()) {
      throw Object.assign(new Error("workspace is not a directory"), { code: "NO_WORKSPACE" });
    }
    const sessions = await this.listSessions(rp);
    return {
      cwd: rp,
      models: FAKE_MODELS,
      sessions,
      diagnostics: [`fake workspace: ${rp}`],
      commands: FAKE_COMMANDS
    };
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const dir = sessionDirFor(cwd);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      files = [];
    }
    const out: SessionSummary[] = [];
    for (const f of files) {
      const real = join(dir, f);
      const p = loadPersisted(real);
      if (!p) continue;
      const firstUser = p.items.find((i) => i.kind === "user");
      out.push({
        sessionId: opaqueFromReal(real),
        name: p.name,
        cwd: p.cwd,
        created: p.created,
        modified: p.modified,
        messageCount: p.items.length,
        firstMessage: firstUser && firstUser.kind === "user" ? firstUser.text.slice(0, 200) : undefined
      });
    }
    out.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
    return out;
  }

  async createChat(workspaceId: string, cwd: string, name?: string): Promise<ChatHandle> {
    const id = randomUUID().slice(0, 8);
    const real = realPathFor(cwd, `${Date.now().toString(36)}-${id}`);
    const persisted: PersistedSession = {
      id: basename(real, ".jsonl"),
      name,
      cwd,
      created: Date.now(),
      modified: Date.now(),
      items: [],
      model: FAKE_MODELS[1],
      thinking: "medium",
      toolMode: "readonly"
    };
    savePersisted(real, persisted);
    return this.attach(workspaceId, cwd, real);
  }

  async resumeChat(workspaceId: string, cwd: string, opaqueSessionId: string): Promise<ChatHandle> {
    const real = await this.resolveSessionPath(cwd, opaqueSessionId);
    return this.attach(workspaceId, cwd, real);
  }

  private async attach(workspaceId: string, cwd: string, real: string): Promise<ChatHandle> {
    // Single ownership: never two live writers for one session file.
    // A second resume attaches to the existing live chat instead of becoming a second writer.
    const existingChatId = this.fileToChat.get(real);
    if (existingChatId) {
      const existing = this.chats.get(existingChatId);
      if (existing) {
        existing.workspaceId = workspaceId;
        existing.cwd = cwd;
        return existing;
      } else {
        this.fileToChat.delete(real);
      }
    }
    const persisted = loadPersisted(real);
    if (!persisted) throw Object.assign(new Error("session not found"), { code: "NOT_FOUND" });
    // Rebuild snapshot via active-branch equivalent: for fake, items are already active branch
    const chat = new FakeChat(this, workspaceId, cwd, persisted, real);
    this.chats.set(chat.chatId, chat);
    this.fileToChat.set(real, chat.chatId);
    return chat;
  }

  getChat(chatId: string): ChatHandle | undefined {
    return this.chats.get(chatId);
  }

  release(chat: FakeChat): void {
    this.chats.delete(chat.chatId);
    const f = chat.getSessionFile();
    if (f && this.fileToChat.get(f) === chat.chatId) this.fileToChat.delete(f);
  }
}
