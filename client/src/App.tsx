import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBootstrap,
  openWorkspace,
  listSessions,
  createChat,
  resumeChat,
  fetchSnapshot,
  sendMessage,
  abortChat,
  patchConfig,
  renameChat,
  compactChat,
  respondExtension,
  connectSse,
  loadDraft,
  saveDraft,
  loadRecentPaths,
  saveRecentPath,
  type ConnState
} from "./api.ts";
import { SafeMarkdown } from "./markdown.tsx";
import type { ChatItem, ModelInfo, ServerEvent, SessionSummary, Snapshot, ThinkingLevel, ToolMode } from "../../src/shared/protocol.ts";
import "./styles.css";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 820);
  useEffect(() => {
    const onResize = (): void => setMobile(window.innerWidth < 820);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mobile;
}

function applyEvent(prev: Snapshot | null, ev: ServerEvent): Snapshot | null {
  if (!prev) {
    if (ev.type === "snapshot") return ev.snapshot;
    return prev;
  }
  switch (ev.type) {
    case "snapshot":
      return ev.snapshot;
    case "run_status":
      return { ...prev, runStatus: ev.status };
    case "item_added": {
      if (prev.items.some((i) => i.id === ev.item.id)) {
        return { ...prev, items: prev.items.map((i) => (i.id === ev.item.id ? ev.item : i)) };
      }
      return { ...prev, items: [...prev.items, ev.item] };
    }
    case "item_updated": {
      return { ...prev, items: prev.items.map((i) => (i.id === ev.item.id ? ev.item : i)) };
    }
    case "assistant_delta": {
      return {
        ...prev,
        items: prev.items.map((i) => (i.id === ev.messageId && i.kind === "assistant" ? { ...i, text: i.text + ev.delta } : i))
      };
    }
    case "assistant_end": {
      return {
        ...prev,
        items: prev.items.map((i) => (i.id === ev.messageId && i.kind === "assistant" ? { ...i, completed: true } : i))
      };
    }
    case "thinking_delta": {
      return {
        ...prev,
        items: prev.items.map((i) => (i.id === ev.thinkingId && i.kind === "thinking" ? { ...i, text: i.text + ev.delta } : i))
      };
    }
    case "thinking_end": {
      return {
        ...prev,
        items: prev.items.map((i) => (i.id === ev.thinkingId && i.kind === "thinking" ? { ...i, completed: true } : i))
      };
    }
    case "tool_start": {
      if (prev.items.some((i) => i.id === ev.item.id)) return prev;
      return { ...prev, items: [...prev.items, ev.item] };
    }
    case "tool_update":
    case "tool_end": {
      return {
        ...prev,
        items: prev.items.map((i) =>
          i.id === ev.id && i.kind === "tool"
            ? { ...i, preview: ev.preview, status: ev.status }
            : i
        )
      };
    }
    case "queue_update":
      return { ...prev, queue: { steering: ev.steering, followUp: ev.followUp } };
    case "notice": {
      const item: ChatItem = { id: `notice-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind: "notice", text: ev.text, level: ev.level, timestamp: Date.now() };
      return { ...prev, items: [...prev.items, item] };
    }
    case "session_meta": {
      return {
        ...prev,
        sessionName: ev.sessionName ?? prev.sessionName,
        model: ev.model ?? prev.model,
        thinking: ev.thinking ?? prev.thinking,
        toolMode: ev.toolMode ?? prev.toolMode
      };
    }
    case "extension_request":
    case "extension_resolved":
      return prev;
    default:
      return prev;
  }
}

interface ExtReq {
  reqId: string;
  method: "select" | "confirm" | "input" | "editor" | "notify";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export default function App(): React.ReactElement {
  const [boot, setBoot] = useState<{ piVersion: string; workspaceHints: string[] } | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [trustNotice, setTrustNotice] = useState<string | undefined>(undefined);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<ConnState>("disconnected");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [sendMode, setSendMode] = useState<"normal" | "steer" | "followUp">("normal");
  const [actionError, setActionError] = useState<string | null>(null);
  const [extReqs, setExtReqs] = useState<ExtReq[]>([]);
  const [showJump, setShowJump] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    fetchBootstrap()
      .then((b) => {
        setBoot({ piVersion: b.piVersion, workspaceHints: b.workspaceHints });
        const recents = loadRecentPaths();
        if (recents[0]) setWorkspacePath(recents[0]);
        else if (b.workspaceHints[0]) setWorkspacePath(b.workspaceHints[0]);
      })
      .catch((e: Error) => setBootError(e.message));
  }, []);

  const busy = snapshot?.runStatus !== "idle" && snapshot?.runStatus !== undefined;
  const stopping = snapshot?.runStatus === "stopping";

  const handleEvent = useCallback((ev: ServerEvent) => {
    if (ev.type === "extension_request") {
      if (ev.method === "notify") {
        // fire-and-forget: show as notice via snapshot path? Already handled as notice-like; also surface via applyEvent? extension_request notify doesn't change snapshot, so add notice manually
        setSnapshot((prev) => {
          if (!prev) return prev;
          const item: ChatItem = { id: `n-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind: "notice", text: ev.message ?? "notification", level: (ev.notifyType as "info" | "warning" | "error" | undefined) ?? "info", timestamp: Date.now() };
          return { ...prev, items: [...prev.items, item] };
        });
        return;
      }
      setExtReqs((prev) => (prev.some((r) => r.reqId === ev.reqId) ? prev : [...prev, { reqId: ev.reqId, method: ev.method, title: ev.title, message: ev.message, options: ev.options, placeholder: ev.placeholder, prefill: ev.prefill }]));
      return;
    }
    if (ev.type === "extension_resolved") {
      setExtReqs((prev) => prev.filter((r) => r.reqId !== ev.reqId));
      return;
    }
    setSnapshot((prev) => applyEvent(prev, ev));
  }, []);

  // SSE connect per chat
  useEffect(() => {
    if (!chatId) {
      setSnapshot(null);
      setConn("disconnected");
      return;
    }
    setConn("reconnecting");
    fetchSnapshot(chatId)
      .then(({ snapshot: s }) => {
        setSnapshot(s);
        setComposer(loadDraft(chatId));
      })
      .catch((e: Error) => setActionError(e.message));
    const disconnect = connectSse(chatId, handleEvent, setConn);
    return () => disconnect();
  }, [chatId, handleEvent]);

  // Autoscroll within 96px, else show Jump to latest
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist < 96) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [snapshot?.items.length]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(dist >= 96);
  };

  const doOpenWorkspace = async (p?: string): Promise<void> => {
    const path = (p ?? workspacePath).trim();
    if (!path) return;
    setWorkspaceError(null);
    setActionError(null);
    try {
      const r = await openWorkspace(path);
      setWorkspaceId(r.workspaceId);
      setCwd(r.cwd);
      setModels(r.models);
      setSessions(r.sessions);
      setDiagnostics(r.diagnostics);
      setTrustNotice(r.trustNotice);
      saveRecentPath(r.cwd);
      setChatId(null);
      setSnapshot(null);
    } catch (e) {
      setWorkspaceError(e instanceof Error ? e.message : "open failed");
    }
  };

  const refreshSessions = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const r = await listSessions(workspaceId);
      setSessions(r.sessions);
    } catch {
      /* ignore */
    }
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId) void refreshSessions();
  }, [workspaceId, chatId, refreshSessions]);

  const doNewChat = async (): Promise<void> => {
    if (!workspaceId) return;
    setActionError(null);
    try {
      const r = await createChat(workspaceId);
      setChatId(r.chatId);
      setSnapshot(r.snapshot);
      setDrawerOpen(false);
      void refreshSessions();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "create failed");
    }
  };

  const doResume = async (sessionId: string): Promise<void> => {
    if (!workspaceId) return;
    setActionError(null);
    try {
      const r = await resumeChat(workspaceId, sessionId);
      setChatId(r.chatId);
      setSnapshot(r.snapshot);
      setDrawerOpen(false);
      void refreshSessions();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "resume failed");
    }
  };

  const doSend = async (kind: "normal" | "steer" | "followUp", text: string): Promise<void> => {
    if (!chatId) return;
    const t = text.trim();
    if (!t) return;
    setActionError(null);
    try {
      await sendMessage(chatId, kind, t);
      if (kind === "normal") {
        setComposer("");
        saveDraft(chatId, "");
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "send failed");
    }
  };

  const doStop = async (): Promise<void> => {
    if (!chatId) return;
    try {
      await abortChat(chatId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "stop failed");
    }
  };

  const doConfig = async (cfg: { model?: { provider: string; id: string }; thinking?: ThinkingLevel; toolMode?: ToolMode }): Promise<void> => {
    if (!chatId) return;
    setActionError(null);
    try {
      const r = await patchConfig(chatId, cfg);
      setSnapshot(r.snapshot);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "config failed");
    }
  };

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => `${s.name ?? ""} ${s.firstMessage ?? ""} ${s.sessionId}`.toLowerCase().includes(q));
  }, [sessions, search]);

  const commands = snapshot?.commands ?? [];
  const [slashOpen, setSlashOpen] = useState(false);
  const slashItems = useMemo(() => {
    if (!composer.startsWith("/")) return [];
    const q = composer.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [composer, commands]);

  useEffect(() => {
    setSlashOpen(composer.startsWith("/") && slashItems.length > 0);
  }, [composer, slashItems.length]);

  // Composer autoresize
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [composer]);

  // Persist draft
  useEffect(() => {
    if (chatId) saveDraft(chatId, composer);
  }, [composer, chatId]);

  // Drawer escape + focus
  useEffect(() => {
    if (!drawerOpen) {
      menuBtnRef.current?.focus?.();
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const queueCount = (snapshot?.queue.steering.length ?? 0) + (snapshot?.queue.followUp.length ?? 0);

  return (
    <div className="app">
      <a className="skip" href="#conversation">
        Skip to conversation
      </a>
      <header className="topbar">
        {isMobile && (
          <button ref={menuBtnRef} className="menu-btn" aria-label="Open sessions menu" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
            ☰ Menu
          </button>
        )}
        <div className="brand">Pi Web UI</div>
        <div className="conn" role="status" aria-live="polite" data-conn={conn}>
          {chatId ? conn : "idle"}
        </div>
      </header>

      <div className="layout">
        {/* Sidebar / drawer */}
        <aside className={`sidebar ${isMobile ? (drawerOpen ? "open" : "closed") : ""}`} aria-label="Sessions" aria-hidden={isMobile && !drawerOpen}>
          <div className="side-head">
            <button className="btn primary" onClick={doNewChat} disabled={!workspaceId}>
              New chat
            </button>
            {isMobile && (
              <button className="btn" aria-label="Close sessions menu" onClick={() => setDrawerOpen(false)}>
                ✕
              </button>
            )}
          </div>
          <div className="side-section">
            <label htmlFor="ws-path">Workspace</label>
            <div className="ws-row">
              <input
                id="ws-path"
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="/home/user/project"
                spellCheck={false}
              />
              <button className="btn" onClick={() => doOpenWorkspace()}>
                Open
              </button>
            </div>
            {cwd && <div className="cwd" title={cwd}>Current: {cwd}</div>}
            {workspaceError && <div className="error" role="alert">{workspaceError}</div>}
            {diagnostics.length > 0 && (
              <details className="diag">
                <summary>Diagnostics</summary>
                <ul>
                  {diagnostics.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </details>
            )}
            {trustNotice && <div className="trust" role="note">{trustNotice}</div>}
          </div>
          <div className="side-section">
            <label htmlFor="sess-search">Recent sessions</label>
            <input id="sess-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sessions…" />
            <ul className="sess-list">
              {filteredSessions.map((s) => (
                <li key={s.sessionId}>
                  <button className="sess-item" onClick={() => doResume(s.sessionId)}>
                    <span className="sess-name">{s.name || s.firstMessage?.slice(0, 60) || s.sessionId.slice(0, 12)}</span>
                    {s.messageCount !== undefined && <span className="sess-meta">{s.messageCount} msgs</span>}
                  </button>
                </li>
              ))}
              {workspaceId && filteredSessions.length === 0 && <li className="empty">No sessions yet.</li>}
              {!workspaceId && <li className="empty">Open a workspace to list sessions.</li>}
            </ul>
          </div>
          <div className="side-foot">
            <div className="risk">
              Pi has no built-in sandbox and runs with host user permissions. Tailscale controls network access only.
            </div>
          </div>
        </aside>
        {isMobile && drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden />}

        {/* Main */}
        <main className="main">
          {!boot && !bootError && <div className="state">Loading…</div>}
          {bootError && <div className="error" role="alert">Failed to load: {bootError}</div>}
          {!workspaceId && boot && (
            <div className="state">
              <h1>Open a project</h1>
              <p>Choose the project directory Pi should use as its canonical cwd.</p>
              {models.length === 0 && <p className="warn">No authenticated model yet — run <code>pi</code> and <code>/login</code> locally.</p>}
            </div>
          )}
          {workspaceId && !chatId && (
            <div className="state">
              <h1>No chat yet</h1>
              <p>Create a new chat or resume a native Pi session. Sessions survive server restart.</p>
              <button className="btn primary" onClick={doNewChat}>New chat</button>
              {models.length === 0 && <p className="warn">No authenticated model — run <code>pi</code> and <code>/login</code> locally. The UI will not ask for credentials.</p>}
            </div>
          )}
          {workspaceId && chatId && snapshot && (
            <>
              <div className="controls" role="toolbar" aria-label="Chat controls">
                <label>
                  Model
                  <select
                    value={snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : ""}
                    disabled={busy}
                    onChange={(e) => {
                      const [provider, ...rest] = e.target.value.split("/");
                      const id = rest.join("/");
                      if (provider && id) void doConfig({ model: { provider, id } });
                    }}
                  >
                    <option value="">(default)</option>
                    {models.map((m) => (
                      <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                        {m.provider}/{m.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Thinking
                  <select value={snapshot.thinking ?? "medium"} disabled={busy} onChange={(e) => void doConfig({ thinking: e.target.value as ThinkingLevel })}>
                    {THINKING_LEVELS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Tools
                  <select value={snapshot.toolMode} disabled={busy} onChange={(e) => void doConfig({ toolMode: e.target.value as ToolMode })} title="Read-only is a model-tool allowlist, not an OS sandbox. It does not make loaded extensions harmless.">
                    <option value="readonly">Read-only</option>
                    <option value="full">Full</option>
                  </select>
                </label>
                <span className="tool-hint">Read-only is an allowlist, not a sandbox.</span>
                <button className="btn" onClick={() => { setRenameValue(snapshot.sessionName ?? ""); setRenameOpen(true); }} disabled={busy}>Rename</button>
                <button className="btn" onClick={() => void compactChat(chatId).then(() => fetchSnapshot(chatId).then(({ snapshot: s }) => setSnapshot(s)))} disabled={busy}>Compact</button>
                {queueCount > 0 && <span className="queue" aria-live="polite">Queued: {queueCount}</span>}
              </div>

              {actionError && <div className="error" role="alert">Action failed: {actionError}</div>}
              {conn !== "connected" && <div className="warn" role="status">SSE {conn} — retrying…</div>}

              <div id="conversation" ref={scrollRef} onScroll={onScroll} className="conversation" tabIndex={0} aria-label="Conversation">
                {snapshot.items.map((item) => (
                  <ItemView key={item.id} item={item} />
                ))}
                {snapshot.items.length === 0 && <div className="empty">No messages yet. Send the first prompt below.</div>}
              </div>
              {showJump && (
                <button className="jump" onClick={() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }}>
                  Jump to latest
                </button>
              )}

              <div className="composer-wrap">
                {busy && (
                  <div className="queue-bar" aria-live="polite">
                    <span>{stopping ? "Stopping…" : "Running…"} {queueCount > 0 && `· queued ${queueCount}`}</span>
                    <span className="seg">
                      <button className={`btn small ${sendMode === "steer" ? "active" : ""}`} onClick={() => setSendMode("steer")}>Steer</button>
                      <button className={`btn small ${sendMode === "followUp" ? "active" : ""}`} onClick={() => setSendMode("followUp")}>Follow-up</button>
                    </span>
                  </div>
                )}
                {slashOpen && (
                  <ul className="slash" role="listbox" aria-label="Slash commands">
                    {slashItems.map((c) => (
                      <li key={c.name} role="option" aria-selected={false}>
                        <button
                          onClick={() => {
                            setComposer(`/${c.name} `);
                            textareaRef.current?.focus();
                          }}
                        >
                          /{c.name} — {c.description ?? c.source}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="composer">
                  <textarea
                    ref={textareaRef}
                    value={composer}
                    onChange={(e) => setComposer(e.target.value)}
                    placeholder={busy ? "Queue a follow-up or steer…" : "Send a message… (Enter to send, Shift+Enter newline)"}
                    rows={2}
                    aria-label="Message input"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !isMobile) {
                        const isDesktop = window.matchMedia("(pointer: fine)").matches;
                        if (isDesktop) {
                          e.preventDefault();
                          if (busy && sendMode !== "normal") void doSend(sendMode, composer);
                          else if (!busy) void doSend("normal", composer);
                        }
                      }
                    }}
                  />
                  {!busy ? (
                    <button className="btn primary send" onClick={() => void doSend("normal", composer)} disabled={!composer.trim()}>
                      Send
                    </button>
                  ) : (
                    <>
                      <button className="btn primary send" onClick={() => void doSend(sendMode === "normal" ? "followUp" : sendMode, composer)} disabled={!composer.trim()}>
                        {sendMode === "normal" ? "Queue" : sendMode === "steer" ? "Steer" : "Follow-up"}
                      </button>
                      <button className="btn danger send" onClick={doStop}>
                        Stop
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {renameOpen && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Rename chat">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (chatId && renameValue.trim()) void renameChat(chatId, renameValue.trim()).then(() => fetchSnapshot(chatId).then(({ snapshot: s }) => setSnapshot(s)));
              setRenameOpen(false);
            }}
          >
            <label>
              Name
              <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={300} autoFocus />
            </label>
            <div className="modal-actions">
              <button type="submit" className="btn primary">Save</button>
              <button type="button" className="btn" onClick={() => setRenameOpen(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {extReqs.map((r) => (
        <ExtDialog
          key={r.reqId}
          req={r}
          onRespond={(resp) => {
            if (chatId) void respondExtension(chatId, r.reqId, resp).catch((e: Error) => setActionError(e.message));
            setExtReqs((prev) => prev.filter((x) => x.reqId !== r.reqId));
          }}
        />
      ))}
    </div>
  );
}

function ItemView({ item }: { item: ChatItem }): React.ReactElement {
  const [open, setOpen] = useState(item.kind === "user" || item.kind === "assistant");
  if (item.kind === "user") {
    return (
      <div className="msg user">
        <div className="role">You</div>
        <div className="bubble"><SafeMarkdown text={item.text} /></div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="msg assistant">
        <div className="role">Assistant {item.completed ? "" : "· streaming…"}</div>
        <div className="bubble"><SafeMarkdown text={item.text || "…"} /></div>
      </div>
    );
  }
  if (item.kind === "thinking") {
    return (
      <details className="thinking" open={false}>
        <summary onClick={(e) => { e.preventDefault(); setOpen(!open); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }} tabIndex={0} role="button" aria-expanded={open}>
          Thinking {item.completed ? "" : "· streaming…"}
        </summary>
        {open && <div className="thinking-body">{item.text}</div>}
      </details>
    );
  }
  if (item.kind === "tool") {
    return (
      <details className="tool" open={false}>
        <summary>
          <span className={`dot ${item.status}`} aria-hidden /> {item.toolName} — {item.argsSummary.slice(0, 120)} ({item.status})
        </summary>
        <div className="tool-body">{item.preview}</div>
      </details>
    );
  }
  return <div className={`notice ${item.level}`} role={item.level === "error" ? "alert" : "note"}>{item.text}</div>;
}

function ExtDialog({ req, onRespond }: { req: ExtReq; onRespond: (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void }): React.ReactElement {
  const [val, setVal] = useState(req.prefill ?? "");
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={req.title ?? "Extension request"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (req.method === "confirm") onRespond({ confirmed: true });
          else onRespond({ value: val });
        }}
      >
        <h2>{req.title ?? "Extension request"}</h2>
        {req.message && <p>{req.message}</p>}
        {req.method === "select" && req.options && (
          <label>
            Choice
            <select value={val} onChange={(e) => setVal(e.target.value)}>
              <option value="">— choose —</option>
              {req.options.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
        )}
        {(req.method === "input" || req.method === "editor") && (
          <label>
            Value
            {req.method === "editor" ? (
              <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={6} placeholder={req.placeholder} />
            ) : (
              <input value={val} onChange={(e) => setVal(e.target.value)} placeholder={req.placeholder} />
            )}
          </label>
        )}
        {req.method === "confirm" && <p>Confirm? This will not auto-confirm; you must choose.</p>}
        <div className="modal-actions">
          {req.method === "confirm" ? (
            <>
              <button type="submit" className="btn primary">Confirm</button>
              <button type="button" className="btn" onClick={() => onRespond({ confirmed: false, cancelled: true })}>Cancel</button>
            </>
          ) : (
            <>
              <button type="submit" className="btn primary" disabled={req.method === "select" && !val}>Submit</button>
              <button type="button" className="btn" onClick={() => onRespond({ cancelled: true })}>Dismiss</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
