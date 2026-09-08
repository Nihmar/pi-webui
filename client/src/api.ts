import type { Snapshot, ServerEvent, ChatItem, ModelInfo, ThinkingLevel, ToolMode, SessionSummary } from "../../src/shared/protocol.ts";

const CSRF_KEY = "pi-csrf";

export function getCsrf(): string {
  return sessionStorage.getItem(CSRF_KEY) ?? "";
}
export function setCsrf(t: string): void {
  sessionStorage.setItem(CSRF_KEY, t);
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined)
  };
  if (init.method && init.method !== "GET") {
    const csrf = getCsrf();
    if (csrf) headers["x-pi-csrf"] = csrf;
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      msg = j.error?.message ?? msg;
      const err = new Error(msg) as Error & { code?: string | undefined; status?: number | undefined };
      if (j.error?.code) err.code = j.error.code;
      err.status = res.status;
      throw err;
    } catch (e) {
      if (e instanceof Error && (e as { status?: number }).status) throw e;
      throw new Error(`request failed: ${res.status}`);
    }
  }
  return res;
}

export async function fetchBootstrap(): Promise<{ csrfToken: string; piVersion: string; modelsAvailable: boolean; workspaceHints: string[] }> {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error("bootstrap failed");
  const j = (await res.json()) as { csrfToken: string; piVersion: string; modelsAvailable: boolean; workspaceHints: string[] };
  setCsrf(j.csrfToken);
  return j;
}

export async function openWorkspace(path: string): Promise<{ workspaceId: string; cwd: string; models: ModelInfo[]; sessions: SessionSummary[]; diagnostics: string[]; trustNotice?: string }> {
  const res = await req("/api/workspaces/open", { method: "POST", body: JSON.stringify({ path }) });
  return (await res.json()) as { workspaceId: string; cwd: string; models: ModelInfo[]; sessions: SessionSummary[]; diagnostics: string[]; trustNotice?: string };
}

export async function listSessions(workspaceId: string): Promise<{ sessions: SessionSummary[] }> {
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`);
  if (!res.ok) throw new Error("list sessions failed");
  return (await res.json()) as { sessions: SessionSummary[] };
}

export async function createChat(workspaceId: string, name?: string): Promise<{ chatId: string; snapshot: Snapshot }> {
  const res = await req("/api/chats", { method: "POST", body: JSON.stringify({ workspaceId, name }) });
  return (await res.json()) as { chatId: string; snapshot: Snapshot };
}

export async function resumeChat(workspaceId: string, sessionId: string): Promise<{ chatId: string; snapshot: Snapshot }> {
  const res = await req("/api/chats/resume", { method: "POST", body: JSON.stringify({ workspaceId, sessionId }) });
  return (await res.json()) as { chatId: string; snapshot: Snapshot };
}

export async function fetchSnapshot(chatId: string): Promise<{ snapshot: Snapshot }> {
  const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);
  if (!res.ok) throw new Error("fetch chat failed");
  return (await res.json()) as { snapshot: Snapshot };
}

export async function sendMessage(chatId: string, kind: "normal" | "steer" | "followUp", text: string): Promise<void> {
  await req(`/api/chats/${encodeURIComponent(chatId)}/messages`, { method: "POST", body: JSON.stringify({ kind, text }) });
}

export async function abortChat(chatId: string): Promise<void> {
  await req(`/api/chats/${encodeURIComponent(chatId)}/abort`, { method: "POST", body: JSON.stringify({}) });
}

export async function patchConfig(chatId: string, cfg: { model?: { provider: string; id: string }; thinking?: ThinkingLevel; toolMode?: ToolMode }): Promise<{ snapshot: Snapshot }> {
  const res = await req(`/api/chats/${encodeURIComponent(chatId)}/config`, { method: "PATCH", body: JSON.stringify(cfg) });
  return (await res.json()) as { snapshot: Snapshot };
}

export async function renameChat(chatId: string, name: string): Promise<void> {
  await req(`/api/chats/${encodeURIComponent(chatId)}/rename`, { method: "POST", body: JSON.stringify({ name }) });
}

export async function compactChat(chatId: string, instructions?: string): Promise<void> {
  await req(`/api/chats/${encodeURIComponent(chatId)}/compact`, { method: "POST", body: JSON.stringify({ instructions }) });
}

export async function respondExtension(chatId: string, reqId: string, resp: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> {
  await req(`/api/chats/${encodeURIComponent(chatId)}/extension-response`, { method: "POST", body: JSON.stringify({ reqId, ...resp }) });
}

export type ConnState = "connected" | "reconnecting" | "disconnected";

export function connectSse(
  chatId: string,
  onEvent: (ev: ServerEvent) => void,
  onState: (s: ConnState) => void
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (closed) return;
    onState(es ? "reconnecting" : "connected");
    try {
      es = new EventSource(`/api/chats/${encodeURIComponent(chatId)}/events`);
    } catch {
      onState("disconnected");
      return;
    }
    onState("connected");
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as ServerEvent;
        onEvent(data);
      } catch {
        /* ignore */
      }
    };
    // Named events also arrive via onmessage in most browsers when using event: field? EventSource dispatches by event name.
    // Add generic listener for all named types via addEventListener fallback:
    const types = ["snapshot", "run_status", "item_added", "item_updated", "assistant_delta", "assistant_end", "thinking_delta", "thinking_end", "tool_start", "tool_update", "tool_end", "queue_update", "notice", "extension_request", "extension_resolved", "session_meta"];
    for (const t of types) {
      try {
        es.addEventListener(t, (e) => {
          try {
            const data = JSON.parse((e as MessageEvent).data) as ServerEvent;
            onEvent(data);
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
    }
    es.onerror = () => {
      if (closed) return;
      onState("reconnecting");
      try {
        es?.close();
      } catch {
        /* ignore */
      }
      es = null;
      // EventSource auto-reconnects, but if server closed, retry manually after 2s
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (!closed) connect();
      }, 2000);
    };
  };
  connect();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    try {
      es?.close();
    } catch {
      /* ignore */
    }
    onState("disconnected");
  };
}

export function loadDraft(chatId: string): string {
  try {
    return localStorage.getItem(`draft:${chatId}`) ?? localStorage.getItem("draft:global") ?? "";
  } catch {
    return "";
  }
}
export function saveDraft(chatId: string, text: string): void {
  try {
    localStorage.setItem(`draft:${chatId}`, text);
    localStorage.setItem("draft:global", text);
  } catch {
    /* ignore */
  }
}
export function loadRecentPaths(): string[] {
  try {
    return JSON.parse(localStorage.getItem("recentPaths") ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function saveRecentPath(p: string): void {
  try {
    const cur = loadRecentPaths().filter((x) => x !== p);
    cur.unshift(p);
    localStorage.setItem("recentPaths", JSON.stringify(cur.slice(0, 10)));
  } catch {
    /* ignore */
  }
}

export type { Snapshot, ServerEvent, ChatItem };
