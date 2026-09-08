import type {
  ExtensionCommand,
  ModelInfo,
  SessionSummary,
  Snapshot,
  ThinkingLevel,
  ToolMode
} from "../shared/protocol.js";

export interface WorkspaceData {
  cwd: string;
  models: ModelInfo[];
  sessions: SessionSummary[];
  diagnostics: string[];
  trustNotice?: string;
  commands: ExtensionCommand[];
}

export interface ChatHandle {
  chatId: string;
  workspaceId: string;
  cwd: string;
  generation: number;
  getSnapshot(): Snapshot;
  /** Subscribe to server events; returns unsubscribe. Listener receives event + monotonic seq. */
  subscribe(listener: (event: import("../shared/protocol.js").ServerEvent) => void): () => void;
  getEventsSince(lastId: number): { events: { id: number; event: import("../shared/protocol.js").ServerEvent }[]; nextId: number };
  send(kind: "normal" | "steer" | "followUp", text: string): Promise<{ accepted: boolean; queued: boolean }>;
  abort(): Promise<void>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  setConfig(opts: { model?: { provider: string; id: string } | undefined; thinking?: ThinkingLevel | undefined; toolMode?: ToolMode | undefined }): Promise<void>;
  rename(name: string): Promise<void>;
  compact(instructions?: string | undefined): Promise<{ summary: string }>;
  respondToExtension(reqId: string, resp: { value?: string | undefined; confirmed?: boolean | undefined; cancelled?: boolean | undefined }): Promise<void>;
  dispose(): Promise<void>;
  getSessionFile(): string | undefined;
}

export interface PiAdapter {
  name: "fake" | "real";
  piVersion(): string;
  openWorkspace(cwd: string): Promise<WorkspaceData>;
  listSessions(cwd: string): Promise<SessionSummary[]>;
  createChat(workspaceId: string, cwd: string, name?: string): Promise<ChatHandle>;
  resumeChat(workspaceId: string, cwd: string, opaqueSessionId: string): Promise<ChatHandle>;
  getChat(chatId: string): ChatHandle | undefined;
  /** Resolve opaque session id to real path (validates against fresh listing). */
  resolveSessionPath(cwd: string, opaqueSessionId: string): Promise<string>;
  toOpaqueSessionId(realPath: string): string;
}
