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
import { useI18n, LanguageSwitch } from "./i18n.tsx";
import type { ChatItem, ModelInfo, ServerEvent, SessionSummary, Snapshot, ThinkingLevel, ToolMode } from "../../src/shared/protocol.ts";
import "./styles.css";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Official Pi mark; inherits color via currentColor so it works in light & dark.
function PiLogo({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 800 800" fill="currentColor" aria-hidden="true" focusable="false">
      <path fillRule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z" />
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

function Icon({ path, size = 15 }: { path: React.ReactNode; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {path}
    </svg>
  );
}
const ICON_REASON = (<><path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2z" /><line x1="9" y1="22" x2="15" y2="22" /></>);
const ICON_TOOL = (<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2.1-.6-.6-2.1z" />);
const ICON_CHEV = (<polyline points="9 18 15 12 9 6" />);
const ICON_SEND = (<><line x1="12" y1="19" x2="12" y2="5" /><polyline points="6 11 12 5 18 11" /></>);
const ICON_MENU = (<><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>);
const ICON_SLIDERS = (<><line x1="4" y1="8" x2="20" y2="8" /><circle cx="9" cy="8" r="2.3" /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="15" cy="16" r="2.3" /></>);

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isMobile = useIsMobile();
  const { t } = useI18n();
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
    const trimmed = text.trim();
    if (!trimmed) return;
    setActionError(null);
    try {
      await sendMessage(chatId, kind, trimmed);
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
        {t("skip")}
      </a>
      <header className="topbar">
        {isMobile && (
          <button ref={menuBtnRef} className="menu-btn" aria-label={t("ariaOpenMenu")} aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
            <Icon path={ICON_MENU} size={20} />
          </button>
        )}
        <div className="brand"><PiLogo className="pi-mark" /> Pi Web UI</div>
        <div className="conn" role="status" aria-live="polite" data-conn={conn}>
          {chatId
            ? t(conn === "connected" ? "connConnected" : conn === "reconnecting" ? "connReconnecting" : "connDisconnected")
            : t("connIdle")}
        </div>
      </header>

      <div className="layout">
        {/* Sidebar / drawer */}
        <aside className={`sidebar ${isMobile ? (drawerOpen ? "open" : "closed") : ""}`} aria-label={t("ariaSessions")} aria-hidden={isMobile && !drawerOpen}>
          <div className="side-head">
            <button className="btn primary" onClick={doNewChat} disabled={!workspaceId}>
              {t("newChat")}
            </button>
            {isMobile && (
              <button className="btn" aria-label={t("ariaCloseMenu")} onClick={() => setDrawerOpen(false)}>
                ✕
              </button>
            )}
          </div>
          <div className="side-section">
            <label htmlFor="ws-path">{t("workspace")}</label>
            <div className="ws-row">
              <input
                id="ws-path"
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="/home/user/project"
                spellCheck={false}
              />
              <button className="btn" onClick={() => doOpenWorkspace()}>
                {t("open")}
              </button>
            </div>
            {cwd && <div className="cwd" title={cwd}>{t("currentPrefix")}{cwd}</div>}
            {workspaceError && <div className="error" role="alert">{workspaceError}</div>}
            {diagnostics.length > 0 && (
              <details className="diag">
                <summary>{t("diagnostics")}</summary>
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
            <label htmlFor="sess-search">{t("recentSessions")}</label>
            <input id="sess-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchSessions")} />
            <ul className="sess-list">
              {filteredSessions.map((s) => (
                <li key={s.sessionId}>
                  <button className="sess-item" onClick={() => doResume(s.sessionId)}>
                    <span className="sess-name">{s.name || s.firstMessage?.slice(0, 60) || s.sessionId.slice(0, 12)}</span>
                    {s.messageCount !== undefined && <span className="sess-meta">{s.messageCount} {t("msgsSuffix")}</span>}
                  </button>
                </li>
              ))}
              {workspaceId && filteredSessions.length === 0 && <li className="empty">{t("noSessions")}</li>}
              {!workspaceId && <li className="empty">{t("openToList")}</li>}
            </ul>
          </div>
          <div className="side-foot">
            <LanguageSwitch />
            <div className="risk">
              {t("risk")}
            </div>
          </div>
        </aside>
        {isMobile && drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden />}

        {/* Main */}
        <main className="main">
          {!boot && !bootError && <div className="state">{t("loading")}</div>}
          {bootError && <div className="error" role="alert">{t("failedToLoad")}{bootError}</div>}
          {!workspaceId && boot && (
            <div className="state">
              <PiLogo className="pi-mark" />
              <h1>{t("openProjectTitle")}</h1>
              <p>{t("openProjectBody")}</p>
              {models.length === 0 && <p className="warn">{t("noModelA")} <code>pi</code> {t("noModelB")} <code>/login</code> {t("noModelC")}</p>}
            </div>
          )}
          {workspaceId && !chatId && (
            <div className="state">
              <PiLogo className="pi-mark" />
              <h1>{t("noChatTitle")}</h1>
              <p>{t("noChatBody")}</p>
              <button className="btn primary" onClick={doNewChat}>{t("newChat")}</button>
              {models.length === 0 && <p className="warn">{t("noModelA")} <code>pi</code> {t("noModelB")} <code>/login</code> {t("noModelC")} {t("noCreds")}</p>}
            </div>
          )}
          {workspaceId && chatId && snapshot && (
            <>
              {actionError && <div className="error" role="alert">{t("actionFailed")}{actionError}</div>}
              {conn !== "connected" && <div className="warn" role="status">SSE {conn} {t("sseRetry")}</div>}

              <div id="conversation" ref={scrollRef} onScroll={onScroll} className="conversation" tabIndex={0} aria-label={t("ariaConversation")}>
                {snapshot.items.map((item) => (
                  <ItemView key={item.id} item={item} />
                ))}
                {snapshot.items.length === 0 && <div className="empty">{t("emptyConvo")}</div>}
              </div>
              {showJump && (
                <button className="jump" onClick={() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }}>
                  {t("jump")}
                </button>
              )}

              <div className="composer-wrap">
                {busy && (
                  <div className="queue-bar" aria-live="polite">
                    <span className="live">{stopping ? t("stopping") : t("running")} {queueCount > 0 && `· ${queueCount} ${t("queuedInline")}`}</span>
                    <span className="seg">
                      <button className={`btn small ${sendMode === "steer" ? "active" : ""}`} onClick={() => setSendMode("steer")}>{t("steer")}</button>
                      <button className={`btn small ${sendMode === "followUp" ? "active" : ""}`} onClick={() => setSendMode("followUp")}>{t("followUp")}</button>
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
                {settingsOpen && (
                  <div className="settings-panel" role="group" aria-label={t("ariaChatControls")}>
                    <label className="settings-row">
                      <span>{t("model")}</span>
                      <select
                        value={snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : ""}
                        disabled={busy}
                        onChange={(e) => {
                          const [provider, ...rest] = e.target.value.split("/");
                          const id = rest.join("/");
                          if (provider && id) void doConfig({ model: { provider, id } });
                        }}
                      >
                        <option value="">{t("modelDefault")}</option>
                        {models.map((m) => (
                          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                            {m.provider}/{m.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="settings-row">
                      <span>{t("thinking")}</span>
                      <select value={snapshot.thinking ?? "medium"} disabled={busy} onChange={(e) => void doConfig({ thinking: e.target.value as ThinkingLevel })}>
                        {THINKING_LEVELS.map((lvl) => (
                          <option key={lvl} value={lvl}>{lvl}</option>
                        ))}
                      </select>
                    </label>
                    <label className="settings-row">
                      <span>{t("tools")}</span>
                      <select value={snapshot.toolMode} disabled={busy} onChange={(e) => void doConfig({ toolMode: e.target.value as ToolMode })} title={t("toolTitle")}>
                        <option value="readonly">{t("readonly")}</option>
                        <option value="full">{t("full")}</option>
                      </select>
                    </label>
                    <div className="settings-hint">{t("toolHint")}</div>
                    <div className="settings-actions">
                      <button className="btn" onClick={() => { setRenameValue(snapshot.sessionName ?? ""); setRenameOpen(true); setSettingsOpen(false); }} disabled={busy}>{t("rename")}</button>
                      <button className="btn" onClick={() => void compactChat(chatId).then(() => fetchSnapshot(chatId).then(({ snapshot: s }) => setSnapshot(s)))} disabled={busy}>{t("compact")}</button>
                    </div>
                  </div>
                )}
                <div className="composer">
                  <button
                    type="button"
                    className={`composer-btn ${settingsOpen ? "on" : ""}`}
                    aria-label={t("settings")}
                    aria-expanded={settingsOpen}
                    title={t("settings")}
                    onClick={() => setSettingsOpen((o) => !o)}
                  >
                    <Icon path={ICON_SLIDERS} size={19} />
                  </button>
                  <textarea
                    ref={textareaRef}
                    value={composer}
                    onChange={(e) => setComposer(e.target.value)}
                    placeholder={busy ? t("composerBusy") : t("composerIdle")}
                    rows={2}
                    aria-label={t("ariaMessageInput")}
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
                    <button className="send" aria-label={t("send")} title={t("send")} onClick={() => void doSend("normal", composer)} disabled={!composer.trim()}>
                      <Icon path={ICON_SEND} size={18} />
                    </button>
                  ) : (
                    <>
                      <button
                        className="send"
                        aria-label={sendMode === "normal" ? t("queueAction") : sendMode === "steer" ? t("steer") : t("followUp")}
                        title={sendMode === "normal" ? t("queueAction") : sendMode === "steer" ? t("steer") : t("followUp")}
                        onClick={() => void doSend(sendMode === "normal" ? "followUp" : sendMode, composer)}
                        disabled={!composer.trim()}
                      >
                        <Icon path={ICON_SEND} size={18} />
                      </button>
                      <button className="send danger" aria-label={t("stop")} title={t("stop")} onClick={doStop}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
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
        <div className="modal" role="dialog" aria-modal="true" aria-label={t("renameTitle")}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (chatId && renameValue.trim()) void renameChat(chatId, renameValue.trim()).then(() => fetchSnapshot(chatId).then(({ snapshot: s }) => setSnapshot(s)));
              setRenameOpen(false);
            }}
          >
            <h2>{t("renameTitle")}</h2>
            <label>
              {t("name")}
              <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={300} autoFocus />
            </label>
            <div className="modal-actions">
              <button type="submit" className="btn primary">{t("save")}</button>
              <button type="button" className="btn" onClick={() => setRenameOpen(false)}>{t("cancel")}</button>
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
  if (item.kind === "user") {
    return (
      <div className="msg user">
        <div className="bubble"><SafeMarkdown text={item.text} /></div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="msg assistant">
        {item.text ? <SafeMarkdown text={item.text} /> : <div className="md"><span className="streaming-caret">▍</span></div>}
      </div>
    );
  }
  if (item.kind === "thinking") return <ReasoningItem item={item} />;
  if (item.kind === "tool") return <ToolItem item={item} />;
  return <div className={`notice ${item.level}`} role={item.level === "error" ? "alert" : "note"}>{item.text}</div>;
}

function ReasoningItem({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }): React.ReactElement {
  const { t } = useI18n();
  // Auto-open while streaming so the reasoning is visible as it arrives; the native
  // <details> toggle (tracked in state) then lets the reader collapse/expand freely.
  const [open, setOpen] = useState(!item.completed);
  return (
    <details className="rz reason" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon path={ICON_REASON} />
        <span>{t("reasoning")}</span>
        {!item.completed && <span className="pulse" aria-hidden />}
        {!item.completed && <span className="tag">{t("streaming")}</span>}
        <span className="chev"><Icon path={ICON_CHEV} size={16} /></span>
      </summary>
      <div className="reason-body">{item.text || "…"}</div>
    </details>
  );
}

function ToolItem({ item }: { item: Extract<ChatItem, { kind: "tool" }> }): React.ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const stCls = item.status === "success" ? "ok" : item.status === "error" ? "err" : "run";
  const stLabel = item.status === "success" ? t("stSuccess") : item.status === "error" ? t("stError") : t("stRunning");
  const args = item.argsSummary.startsWith(item.toolName)
    ? item.argsSummary.slice(item.toolName.length).trim()
    : item.argsSummary;
  const noOutput = !item.preview || item.preview === "[tool call]" || item.preview === "[tool result]" || item.preview === "running…";
  return (
    <details className="rz tool" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <Icon path={ICON_TOOL} />
        <span className="tool-name">{item.toolName}</span>
        <span className="tool-args">{args}</span>
        <span className={`st ${stCls}`}>
          {item.status === "running" ? <span className="spin" aria-hidden /> : <span className="d" aria-hidden />}
          {stLabel}
        </span>
        <span className="chev"><Icon path={ICON_CHEV} size={16} /></span>
      </summary>
      <div className="tool-body">{noOutput ? <span className="tool-empty">{t("toolNoOutput")}</span> : item.preview}</div>
    </details>
  );
}

function ExtDialog({ req, onRespond }: { req: ExtReq; onRespond: (r: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void }): React.ReactElement {
  const { t } = useI18n();
  const [val, setVal] = useState(req.prefill ?? "");
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={req.title ?? t("extTitle")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (req.method === "confirm") onRespond({ confirmed: true });
          else onRespond({ value: val });
        }}
      >
        <h2>{req.title ?? t("extTitle")}</h2>
        {req.message && <p>{req.message}</p>}
        {req.method === "select" && req.options && (
          <label>
            {t("choice")}
            <select value={val} onChange={(e) => setVal(e.target.value)}>
              <option value="">{t("choose")}</option>
              {req.options.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </label>
        )}
        {(req.method === "input" || req.method === "editor") && (
          <label>
            {t("value")}
            {req.method === "editor" ? (
              <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={6} placeholder={req.placeholder} />
            ) : (
              <input value={val} onChange={(e) => setVal(e.target.value)} placeholder={req.placeholder} />
            )}
          </label>
        )}
        {req.method === "confirm" && <p>{t("confirmQ")}</p>}
        <div className="modal-actions">
          {req.method === "confirm" ? (
            <>
              <button type="submit" className="btn primary">{t("confirm")}</button>
              <button type="button" className="btn" onClick={() => onRespond({ confirmed: false, cancelled: true })}>{t("cancel")}</button>
            </>
          ) : (
            <>
              <button type="submit" className="btn primary" disabled={req.method === "select" && !val}>{t("submit")}</button>
              <button type="button" className="btn" onClick={() => onRespond({ cancelled: true })}>{t("dismiss")}</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
