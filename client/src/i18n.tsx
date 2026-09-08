import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

// Lightweight, dependency-free i18n for the UI chrome (buttons, labels, states).
// Conversation content is the agent's output and is never translated here.
export type Lang = "en" | "it";
export const LANGS: Lang[] = ["en", "it"];
const STORE_KEY = "pi-lang";

const en = {
  menu: "Menu",
  ariaOpenMenu: "Open sessions menu",
  ariaCloseMenu: "Close sessions menu",
  ariaSessions: "Sessions",
  ariaConversation: "Conversation",
  ariaChatControls: "Chat controls",
  ariaMessageInput: "Message input",
  skip: "Skip to conversation",

  connIdle: "idle",
  connConnected: "connected",
  connReconnecting: "reconnecting",
  connDisconnected: "disconnected",

  newChat: "New chat",
  workspace: "Workspace",
  open: "Open",
  currentPrefix: "Current: ",
  diagnostics: "Diagnostics",
  recentSessions: "Recent sessions",
  searchSessions: "Search sessions…",
  noSessions: "No sessions yet.",
  openToList: "Open a workspace to list sessions.",
  msgsSuffix: "msgs",
  language: "Language",
  risk: "Pi has no built-in sandbox and runs with host user permissions. Tailscale controls network access only.",

  loading: "Loading…",
  failedToLoad: "Failed to load: ",
  openProjectTitle: "Open a project",
  openProjectBody: "Choose the project directory Pi should use as its canonical cwd.",
  noChatTitle: "No chat yet",
  noChatBody: "Create a new chat or resume a native Pi session. Sessions survive server restart.",
  noModelA: "No authenticated model yet — run",
  noModelB: "and",
  noModelC: "locally.",
  noCreds: "The UI will not ask for credentials.",

  settings: "Settings",
  toolNoOutput: "No saved output for this call.",
  model: "Model",
  modelDefault: "(default)",
  thinking: "Thinking",
  tools: "Tools",
  readonly: "Read-only",
  full: "Full",
  toolHint: "Read-only is an allowlist, not a sandbox.",
  toolTitle: "Read-only is a model-tool allowlist, not an OS sandbox. It does not make loaded extensions harmless.",
  rename: "Rename",
  compact: "Compact",
  queued: "Queued:",

  emptyConvo: "No messages yet. Send the first prompt below.",
  jump: "Jump to latest",
  reasoning: "Reasoning",
  streaming: "streaming…",
  stRunning: "running",
  stSuccess: "success",
  stError: "error",
  actionFailed: "Action failed: ",
  sseRetry: "— retrying…",

  running: "Running…",
  stopping: "Stopping…",
  queuedInline: "queued",
  steer: "Steer",
  followUp: "Follow-up",
  send: "Send",
  stop: "Stop",
  queueAction: "Queue",
  composerBusy: "Queue a follow-up or steer…",
  composerIdle: "Send a message…",

  renameTitle: "Rename chat",
  name: "Name",
  save: "Save",
  cancel: "Cancel",
  extTitle: "Extension request",
  choice: "Choice",
  choose: "— choose —",
  value: "Value",
  confirmQ: "Confirm? This will not auto-confirm; you must choose.",
  confirm: "Confirm",
  submit: "Submit",
  dismiss: "Dismiss"
};

export type StringKey = keyof typeof en;

const it: typeof en = {
  menu: "Menu",
  ariaOpenMenu: "Apri il menu delle sessioni",
  ariaCloseMenu: "Chiudi il menu delle sessioni",
  ariaSessions: "Sessioni",
  ariaConversation: "Conversazione",
  ariaChatControls: "Controlli della chat",
  ariaMessageInput: "Campo messaggio",
  skip: "Vai alla conversazione",

  connIdle: "inattivo",
  connConnected: "connesso",
  connReconnecting: "riconnessione",
  connDisconnected: "disconnesso",

  newChat: "Nuova chat",
  workspace: "Progetto",
  open: "Apri",
  currentPrefix: "Corrente: ",
  diagnostics: "Diagnostica",
  recentSessions: "Sessioni recenti",
  searchSessions: "Cerca sessioni…",
  noSessions: "Nessuna sessione.",
  openToList: "Apri un progetto per vedere le sessioni.",
  msgsSuffix: "msg",
  language: "Lingua",
  risk: "Pi non ha una sandbox e gira con i permessi del tuo utente. Tailscale controlla solo l'accesso di rete.",

  loading: "Caricamento…",
  failedToLoad: "Caricamento fallito: ",
  openProjectTitle: "Apri un progetto",
  openProjectBody: "Scegli la cartella del progetto che Pi userà come cwd.",
  noChatTitle: "Ancora nessuna chat",
  noChatBody: "Crea una nuova chat o riprendi una sessione Pi nativa. Le sessioni sopravvivono al riavvio del server.",
  noModelA: "Nessun modello autenticato — esegui",
  noModelB: "e",
  noModelC: "in locale.",
  noCreds: "L'interfaccia non chiederà credenziali.",

  settings: "Impostazioni",
  toolNoOutput: "Nessun output salvato per questa chiamata.",
  model: "Modello",
  modelDefault: "(predefinito)",
  thinking: "Ragionamento",
  tools: "Strumenti",
  readonly: "Sola lettura",
  full: "Completo",
  toolHint: "Sola lettura è una allowlist, non una sandbox.",
  toolTitle: "Sola lettura è una allowlist di strumenti del modello, non una sandbox del sistema. Non rende innocue le estensioni caricate.",
  rename: "Rinomina",
  compact: "Compatta",
  queued: "In coda:",

  emptyConvo: "Nessun messaggio. Invia il primo prompt qui sotto.",
  jump: "Vai all'ultimo",
  reasoning: "Ragionamento",
  streaming: "in arrivo…",
  stRunning: "in corso",
  stSuccess: "riuscito",
  stError: "errore",
  actionFailed: "Azione fallita: ",
  sseRetry: "— riprovo…",

  running: "In esecuzione…",
  stopping: "Arresto…",
  queuedInline: "in coda",
  steer: "Correggi",
  followUp: "A seguire",
  send: "Invia",
  stop: "Ferma",
  queueAction: "Accoda",
  composerBusy: "Accoda un follow-up o correggi…",
  composerIdle: "Scrivi un messaggio…",

  renameTitle: "Rinomina chat",
  name: "Nome",
  save: "Salva",
  cancel: "Annulla",
  extTitle: "Richiesta estensione",
  choice: "Scelta",
  choose: "— scegli —",
  value: "Valore",
  confirmQ: "Confermare? Nessuna conferma automatica: devi scegliere.",
  confirm: "Conferma",
  submit: "Invia",
  dismiss: "Ignora"
};

const DICT: Record<Lang, typeof en> = { en, it };

// First launch: use the OS/browser language if supported, otherwise English.
// A remembered explicit choice always wins on later launches.
function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === "en" || saved === "it") return saved;
  } catch {
    /* ignore */
  }
  try {
    const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    for (const l of langs) {
      const code = (l || "").toLowerCase();
      if (code.startsWith("it")) return "it";
      if (code.startsWith("en")) return "en";
    }
  } catch {
    /* ignore */
  }
  return "en";
}

interface I18nContext {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: StringKey) => string;
}
const Ctx = createContext<I18nContext | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    try {
      document.documentElement.lang = lang;
    } catch {
      /* ignore */
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback((key: StringKey): string => DICT[lang][key] ?? en[key] ?? key, [lang]);
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nContext {
  const c = useContext(Ctx);
  if (!c) throw new Error("useI18n must be used within LanguageProvider");
  return c;
}

export function LanguageSwitch(): React.ReactElement {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-row">
      <span className="lang-label">{t("language")}</span>
      <div className="lang" role="group" aria-label={t("language")}>
        {LANGS.map((l) => (
          <button
            key={l}
            type="button"
            className={l === lang ? "on" : ""}
            aria-pressed={l === lang}
            onClick={() => setLang(l)}
          >
            {l.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}
