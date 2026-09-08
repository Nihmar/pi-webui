import { z } from "zod";

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const ToolModeSchema = z.enum(["readonly", "full"]);
export type ToolMode = z.infer<typeof ToolModeSchema>;

export const ModelInfoSchema = z.object({
  provider: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional()
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ChatItemSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("user"),
    text: z.string(),
    timestamp: z.number()
  }),
  z.object({
    id: z.string(),
    kind: z.literal("assistant"),
    text: z.string(),
    timestamp: z.number(),
    completed: z.boolean()
  }),
  z.object({
    id: z.string(),
    kind: z.literal("thinking"),
    text: z.string(),
    timestamp: z.number(),
    completed: z.boolean()
  }),
  z.object({
    id: z.string(),
    kind: z.literal("tool"),
    toolName: z.string(),
    argsSummary: z.string(),
    status: z.enum(["running", "success", "error"]),
    preview: z.string(),
    timestamp: z.number()
  }),
  z.object({
    id: z.string(),
    kind: z.literal("notice"),
    text: z.string(),
    level: z.enum(["info", "warning", "error"]),
    timestamp: z.number()
  })
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;

export const RunStatusSchema = z.enum(["idle", "running", "stopping"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const QueueStateSchema = z.object({
  steering: z.array(z.string()),
  followUp: z.array(z.string())
});
export type QueueState = z.infer<typeof QueueStateSchema>;

export const ExtensionCommandSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.enum(["extension", "prompt", "skill"])
});
export type ExtensionCommand = z.infer<typeof ExtensionCommandSchema>;

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  name: z.string().optional(),
  cwd: z.string().optional(),
  created: z.number().optional(),
  modified: z.number().optional(),
  messageCount: z.number().optional(),
  firstMessage: z.string().max(500).optional()
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const SnapshotSchema = z.object({
  chatId: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  sessionId: z.string(),
  sessionName: z.string().optional(),
  model: ModelInfoSchema.optional(),
  thinking: ThinkingLevelSchema.optional(),
  toolMode: ToolModeSchema,
  runStatus: RunStatusSchema,
  items: z.array(ChatItemSchema),
  queue: QueueStateSchema,
  commands: z.array(ExtensionCommandSchema),
  stats: z
    .object({
      userMessages: z.number(),
      assistantMessages: z.number(),
      toolCalls: z.number(),
      totalMessages: z.number()
    })
    .optional(),
  trustNotice: z.string().optional()
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// --- Server-sent events (browser-safe discriminated union) ---
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: SnapshotSchema }),
  z.object({ type: z.literal("run_status"), status: RunStatusSchema }),
  z.object({ type: z.literal("item_added"), item: ChatItemSchema }),
  z.object({ type: z.literal("item_updated"), item: ChatItemSchema }),
  z.object({
    type: z.literal("assistant_delta"),
    messageId: z.string(),
    delta: z.string().max(8000)
  }),
  z.object({ type: z.literal("assistant_end"), messageId: z.string() }),
  z.object({
    type: z.literal("thinking_delta"),
    thinkingId: z.string(),
    delta: z.string().max(8000)
  }),
  z.object({ type: z.literal("thinking_end"), thinkingId: z.string() }),
  z.object({
    type: z.literal("tool_start"),
    item: z.object({
      id: z.string(),
      kind: z.literal("tool"),
      toolName: z.string(),
      argsSummary: z.string(),
      status: z.enum(["running", "success", "error"]),
      preview: z.string(),
      timestamp: z.number()
    })
  }),
  z.object({
    type: z.literal("tool_update"),
    id: z.string(),
    preview: z.string().max(8000),
    status: z.enum(["running", "success", "error"])
  }),
  z.object({
    type: z.literal("tool_end"),
    id: z.string(),
    status: z.enum(["success", "error"]),
    preview: z.string().max(8000)
  }),
  z.object({
    type: z.literal("queue_update"),
    steering: z.array(z.string()),
    followUp: z.array(z.string())
  }),
  z.object({
    type: z.literal("notice"),
    text: z.string().max(4000),
    level: z.enum(["info", "warning", "error"])
  }),
  z.object({
    type: z.literal("extension_request"),
    reqId: z.string(),
    method: z.enum(["select", "confirm", "input", "editor", "notify"]),
    title: z.string().max(500).optional(),
    message: z.string().max(4000).optional(),
    options: z.array(z.string().max(300)).max(30).optional(),
    placeholder: z.string().max(500).optional(),
    prefill: z.string().max(8000).optional(),
    notifyType: z.enum(["info", "warning", "error"]).optional()
  }),
  z.object({
    type: z.literal("extension_resolved"),
    reqId: z.string()
  }),
  z.object({
    type: z.literal("session_meta"),
    sessionName: z.string().max(300).optional(),
    model: ModelInfoSchema.optional(),
    thinking: ThinkingLevelSchema.optional(),
    toolMode: ToolModeSchema.optional()
  })
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// --- API schemas ---
export const WorkspaceOpenRequestSchema = z.object({
  path: z.string().min(1).max(4096)
});
export type WorkspaceOpenRequest = z.infer<typeof WorkspaceOpenRequestSchema>;

export const WorkspaceOpenResponseSchema = z.object({
  workspaceId: z.string(),
  cwd: z.string(),
  models: z.array(ModelInfoSchema),
  sessions: z.array(SessionSummarySchema),
  diagnostics: z.array(z.string()),
  trustNotice: z.string().optional()
});
export type WorkspaceOpenResponse = z.infer<typeof WorkspaceOpenResponseSchema>;

export const ChatCreateRequestSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  name: z.string().max(300).optional()
});
export type ChatCreateRequest = z.infer<typeof ChatCreateRequestSchema>;

export const ChatResumeRequestSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(512)
});
export type ChatResumeRequest = z.infer<typeof ChatResumeRequestSchema>;

export const MessageKindSchema = z.enum(["normal", "steer", "followUp"]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const ChatMessageRequestSchema = z.object({
  kind: MessageKindSchema.default("normal"),
  text: z.string().min(1).max(100_000)
});
export type ChatMessageRequest = z.infer<typeof ChatMessageRequestSchema>;

export const ChatConfigRequestSchema = z
  .object({
    model: z
      .object({
        provider: z.string().min(1).max(128),
        id: z.string().min(1).max(256)
      })
      .optional(),
    thinking: ThinkingLevelSchema.optional(),
    toolMode: ToolModeSchema.optional()
  })
  .refine((v) => v.model !== undefined || v.thinking !== undefined || v.toolMode !== undefined, {
    message: "at least one of model, thinking, toolMode is required"
  });
export type ChatConfigRequest = z.infer<typeof ChatConfigRequestSchema>;

export const RenameRequestSchema = z.object({
  name: z.string().min(1).max(300)
});

export const CompactRequestSchema = z.object({
  instructions: z.string().max(8000).optional()
});

export const ExtensionResponseRequestSchema = z.object({
  reqId: z.string().min(1).max(256),
  value: z.string().max(8000).optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.boolean().optional()
});
export type ExtensionResponseRequest = z.infer<typeof ExtensionResponseRequestSchema>;

export const BootstrapResponseSchema = z.object({
  csrfToken: z.string(),
  piVersion: z.string(),
  modelsAvailable: z.boolean(),
  workspaceHints: z.array(z.string()),
  defaultWorkspace: z.string().optional()
});
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  piVersion: z.string()
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string()
  })
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

// URL policy shared by server + client: allow only safe schemes.
const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);
export function isSafeUrl(url: string): boolean {
  try {
    // Allow relative links and anchors.
    if (url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) return true;
    const parsed = new URL(url, "http://127.0.0.1");
    // If input had no scheme, URL constructor used base; treat as safe relative.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return true;
    return SAFE_URL_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

// Bound tool output for display.
export const MAX_TOOL_PREVIEW_CHARS = 4000;
export function truncatePreview(text: string, max = MAX_TOOL_PREVIEW_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

// Secret redaction: strip obvious credential values from display payloads.
const SECRET_KEYS = ["api_key", "apikey", "api-key", "authorization", "bearer", "token", "secret", "password", "private_key"];
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    // Redact long base64-ish / sk- tokens to avoid leaking credentials in previews.
    if (/^(sk-|xox|ghp_|gho_|Bearer\s+)/i.test(value)) return "[redacted]";
    if (value.length > 2000) return value.slice(0, 2000) + "…[truncated]";
    return value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.some((s) => k.toLowerCase().includes(s))) {
        out[k] = "[redacted]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}
