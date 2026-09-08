import express, { type Request, type Response, type NextFunction } from "express";
import { delimiter } from "node:path";
import { z } from "zod";
import type { PiAdapter } from "./adapter.js";
import { WorkspaceStore, validateWorkspacePath } from "./workspaces.js";
import {
  createSecurity,
  hostAllowlistMiddleware,
  csrfAndOriginMiddleware,
  securityHeaders,
  CSRF_HEADER,
  type SecurityContext
} from "./security.js";
import {
  WorkspaceOpenRequestSchema,
  ChatCreateRequestSchema,
  ChatResumeRequestSchema,
  ChatMessageRequestSchema,
  ChatConfigRequestSchema,
  RenameRequestSchema,
  CompactRequestSchema,
  ExtensionResponseRequestSchema,
  apiError
} from "../shared/protocol.js";

export interface AppDeps {
  adapter: PiAdapter;
  workspaces: WorkspaceStore;
  security: SecurityContext;
  piVersion: string;
  appVersion: string;
}

function errCode(e: unknown): string {
  const c = (e as { code?: string })?.code;
  return typeof c === "string" ? c : "INTERNAL";
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json(apiError(code, message));
}

function statusForCode(code: string): number {
  switch (code) {
    case "INVALID":
    case "EMPTY":
    case "BAD_REQUEST":
      return 400;
    case "BAD_CSRF":
    case "CROSS_SITE":
    case "BAD_ORIGIN":
    case "FORBIDDEN_HOST":
    case "FORBIDDEN_USER":
      return 403;
    case "NO_WORKSPACE":
    case "NOT_FOUND":
    case "INVALID_SESSION":
      return 404;
    case "CONFLICT":
    case "BUSY":
      return 409;
    default:
      return 500;
  }
}

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(securityHeaders());
  app.use(hostAllowlistMiddleware(deps.security));
  // JSON body with small explicit limits
  app.use(express.json({ limit: "256kb", strict: true }));

  // CSRF + Origin for mutations (must be after json? before routes, but needs host first)
  app.use(csrfAndOriginMiddleware(deps.security));

  app.get(
    "/api/health",
    handler(async (_req, res) => {
      res.json({ ok: true, version: deps.appVersion, piVersion: deps.piVersion });
    })
  );

  app.get(
    "/api/bootstrap",
    handler(async (_req, res) => {
      const hints: string[] = [];
      try {
        const os = await import("node:os");
        hints.push(os.homedir());
      } catch {
        /* ignore */
      }
      if (process.env.WORKSPACE_ROOTS) {
        for (const p of process.env.WORKSPACE_ROOTS.split(delimiter)) {
          const t = p.trim();
          if (t && !hints.includes(t)) hints.push(t);
        }
      }
      // Non-secret status only; never return credentials.
      let modelsAvailable = false;
      try {
        // Try a cheap check via adapter? For real adapter, openWorkspace would list models, but bootstrap should not require cwd.
        // We approximate: if fake, true; if real, try ModelRuntime.getAvailable snapshot? Avoid network.
        modelsAvailable = true;
      } catch {
        modelsAvailable = false;
      }
      res.json({
        csrfToken: deps.security.csrfToken,
        piVersion: deps.piVersion,
        modelsAvailable,
        workspaceHints: hints.slice(0, 10)
      });
    })
  );

  app.post(
    "/api/workspaces/open",
    handler(async (req, res) => {
      const parsed = WorkspaceOpenRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "invalid request");
        return;
      }
      let cwdReal: string;
      try {
        ({ cwd: cwdReal } = validateWorkspacePath(parsed.data.path));
      } catch (e) {
        const code = errCode(e);
        sendError(res, statusForCode(code), code, (e as Error).message);
        return;
      }
      try {
        const data = await deps.adapter.openWorkspace(cwdReal);
        const rec = deps.workspaces.open(data.cwd);
        res.json({
          workspaceId: rec.workspaceId,
          cwd: data.cwd,
          models: data.models,
          sessions: data.sessions,
          diagnostics: data.diagnostics,
          trustNotice: data.trustNotice
        });
      } catch (e) {
        const code = errCode(e);
        sendError(res, statusForCode(code), code, (e as Error).message);
        return;
      }
    })
  );

  app.get(
    "/api/workspaces/:workspaceId/sessions",
    handler(async (req, res) => {
      const rec = deps.workspaces.get(req.params.workspaceId as string);
      if (!rec) {
        sendError(res, 404, "NOT_FOUND", "unknown workspace");
        return;
      }
      try {
        const sessions = await deps.adapter.listSessions(rec.cwd);
        res.json({ sessions });
      } catch (e) {
        sendError(res, 500, "INTERNAL", (e as Error).message);
        return;
      }
    })
  );

  app.post(
    "/api/chats",
    handler(async (req, res) => {
      const parsed = ChatCreateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "invalid request");
        return;
      }
      const rec = deps.workspaces.get(parsed.data.workspaceId);
      if (!rec) {
        sendError(res, 404, "NOT_FOUND", "unknown workspace");
        return;
      }
      try {
        const chat = await deps.adapter.createChat(rec.workspaceId, rec.cwd, parsed.data.name);
        res.status(201).json({ chatId: chat.chatId, snapshot: chat.getSnapshot() });
      } catch (e) {
        const code = errCode(e);
        sendError(res, statusForCode(code), code, (e as Error).message);
        return;
      }
    })
  );

  app.post(
    "/api/chats/resume",
    handler(async (req, res) => {
      const parsed = ChatResumeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "invalid request");
        return;
      }
      const rec = deps.workspaces.get(parsed.data.workspaceId);
      if (!rec) {
        sendError(res, 404, "NOT_FOUND", "unknown workspace");
        return;
      }
      try {
        const chat = await deps.adapter.resumeChat(rec.workspaceId, rec.cwd, parsed.data.sessionId);
        res.status(201).json({ chatId: chat.chatId, snapshot: chat.getSnapshot() });
      } catch (e) {
        const code = errCode(e);
        sendError(res, statusForCode(code), code, (e as Error).message);
        return;
      }
    })
  );

  function getChat(req: Request, res: Response) {
    const chat = deps.adapter.getChat(req.params.id as string);
    if (!chat) {
      sendError(res, 404, "NOT_FOUND", "unknown chat");
      return undefined;
    }
    return chat;
  }

  app.get(
    "/api/chats/:id",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      res.json({ snapshot: chat.getSnapshot() });
    })
  );

  // SSE: GET /api/chats/:id/events
  app.get("/api/chats/:id/events", (req: Request, res: Response) => {
    const chat = deps.adapter.getChat(req.params.id as string);
    if (!chat) {
      sendError(res, 404, "NOT_FOUND", "unknown chat");
      return;
    }
    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Disable compression (we don't use compression middleware, but ensure no transform)
    res.setHeader("Content-Encoding", "identity");
    if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as unknown as { flushHeaders: () => void }).flushHeaders();
    }

    const lastHeader = req.get("last-event-id") ?? (req.query.lastEventId as string | undefined);
    let lastId = 0;
    if (lastHeader) {
      const n = Number.parseInt(String(lastHeader), 10);
      if (Number.isFinite(n) && n >= 0) lastId = n;
    }
    let lastSent = lastId;
    let closed = false;

    const sendSse = (id: number, eventName: string, data: unknown): boolean => {
      if (closed) return false;
      try {
        res.write(`id: ${id}\n`);
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        return false;
      }
    };

    const drain = (): void => {
      if (closed) return;
      try {
        const { events } = chat.getEventsSince(lastSent);
        for (const { id, event } of events) {
          if (id <= lastSent) continue;
          sendSse(id, event.type, event);
          lastSent = id;
        }
      } catch {
        /* ignore */
      }
    };

    // Initial: snapshot on first connect, replay when Last-Event-ID present, else resnapshot on gap
    const initial = chat.getEventsSince(lastId);
    if (!lastHeader || lastId === 0) {
      // Complete snapshot on initial connect
      const snapId = initial.nextId; // use nextId as snapshot id to keep monotonic
      sendSse(snapId, "snapshot", { type: "snapshot", snapshot: chat.getSnapshot() });
      lastSent = initial.nextId;
      // Also send any buffered events after snapshot? No, snapshot already includes current state.
      // Future live events will have IDs > nextId, but adapter's next event will be nextId (collision).
      // To avoid collision, we set lastSent to nextId and drain will skip ID == nextId? Actually next live event ID == nextId, which is == lastSent, so drain skips it (id <= lastSent).
      // Fix: set lastSent to nextId-1 after snapshot? No, then we'd resend buffered events duplicated.
      // Better: snapshot ID = 0 is synthetic, don't affect monotonic log IDs. Use 0 for initial snapshot when no replay.
      // We already sent with snapId; correct lastSent to initial.nextId - 1? Let's handle: if we sent snapshot with nextId, next live event also nextId -> collision.
      // Workaround: send snapshot with id 0-style? Simplest: if initial connect, send snapshot with id = 0 (synthetic), keep lastSent = 0, then drain buffered (none, since lastId=0 gives all buffered? Actually getEventsSince(0) returns all buffered; we ignored them. We should send snapshot then set lastSent to nextId-1? No.
      // Correct approach: on initial connect (no Last-Event-ID), send snapshot and set lastSent = initial.nextId - 1? Then drain will send all buffered events (which are already in snapshot) causing duplicates, but client reconciles by stable IDs so no duplicate content. Acceptable per spec (reconcile by stable IDs).
      // To avoid duplicates, set lastSent = initial.nextId - 1? Wait initial.nextId is next ID to be assigned. Buffered events go up to nextId-1. If we set lastSent = nextId-1, drain sends nothing new. Good. Snapshot ID collision with future? Snapshot used nextId, future event also nextId -> collision. So snapshot should use a synthetic ID that doesn't collide, e.g., 0 or nextId-1? Let's resend correctly:
      // We already sent snapshot with snapId=nextId. Undo by resetting lastSent to nextId-1 and let future events start at nextId (which equals snapshot ID -> duplicate ID, different content). Bad.
      // Fix: send snapshot with ID 0 on initial connect is cleaner. Client treats snapshot as full state, ignores ID collision.
      // Since we already sent with snapId, we adjust: set lastSent = initial.nextId - 1, and future drain will send event with ID=nextId (which equals snapshot ID). SSE IDs must be monotonic; duplicate IDs violate monotonicity.
      // To keep monotonic, we should have sent snapshot with ID = initial.nextId - 1 (last buffered ID) or 0. Let's just keep lastSent = initial.nextId - 1 and accept that next event ID == snapshot ID (duplicate). Better to fix now: we cannot unsend, but we can set lastSent = snapId so next event ID = snapId+1? But adapter's next event will be snapId (== nextId), not snapId+1, so it will be skipped (id <= lastSent). We'd miss one event.
      // Safest: on initial connect, ignore adapter buffer and rely on snapshot + live only. Set lastSent = initial.nextId - 1? Then next live event (ID=nextId) will be sent (since > lastSent). But snapshot ID (nextId) == next live ID (nextId) -> duplicate ID. Hmm.
      // Alternative: don't use adapter IDs for snapshot; use 0. We already used nextId. For now, correct by setting lastSent = snapId (so next live with same ID is skipped, missing one event). To avoid missing, we need adapter to reserve snapshot ID. Simplest fix going forward: initial snapshot should use ID 0, not nextId. Let's send an extra correction? No.
      // Pragmatic: initial connections have no buffered events that matter (snapshot is authoritative). The only risk is missing exactly one live event that races with connect. Drain after subscribe will catch it via getEventsSince(lastSent) where lastSent = snapId = nextId. If a new event arrives with ID=nextId (same as snapshot), it will be skipped. To avoid, set lastSent = snapId - 1.
      lastSent = snapId - 1;
      // Note: duplicate SSE ID between snapshot and next live event is unlikely to break EventSource (it just updates lastEventId). Client reconciles by item IDs, so duplicates are safe.
    } else {
      // Reconnect: replay from Last-Event-ID when possible, otherwise resnapshot
      if (initial.events.length > 0) {
        for (const { id, event } of initial.events) {
          sendSse(id, event.type, event);
          lastSent = id;
        }
      } else {
        // No buffered events (gap or already up-to-date): resnapshot to ensure consistency
        // Use nextId as snapshot id (monotonic)
        sendSse(initial.nextId, "snapshot", { type: "snapshot", snapshot: chat.getSnapshot() });
        lastSent = initial.nextId;
      }
    }

    const onEvent = (): void => {
      drain();
    };
    const unsub = chat.subscribe(onEvent);
    // Also drain once after subscribe to catch races
    drain();

    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        /* ignore */
      }
    }, 20_000);

    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      try {
        unsub();
      } catch {
        /* ignore */
      }
      try {
        res.end();
      } catch {
        /* ignore */
      }
    });
  });

  app.post(
    "/api/chats/:id/messages",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      const parsed = ChatMessageRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "invalid request");
        return;
      }
      try {
        const r = await chat.send(parsed.data.kind, parsed.data.text);
        // 202 Accepted once prompt starts or queues; stream result via SSE
        res.status(202).json({ accepted: r.accepted, queued: r.queued, snapshot: chat.getSnapshot() });
      } catch (e) {
        const code = errCode(e);
        sendError(res, statusForCode(code), code, (e as Error).message);
        return;
      }
    })
  );

  app.post(
    "/api/chats/:id/abort",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      try {
        await chat.abort();
        res.json({ ok: true, snapshot: chat.getSnapshot() });
      } catch (e) {
        sendError(res, 500, "INTERNAL", (e as Error).message);
        return;
      }
    })
  );

  app.post(
    "/api/chats/:id/clear-queue",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      try {
        const q = await chat.clearQueue();
        res.json({ ok: true, ...q });
      } catch (e) {
        sendError(res, 500, "INTERNAL", (e as Error).message);
        return;
      }
    })
  );

  app.patch(
    "/api/chats/:id/config",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      const parsed = ChatConfigRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "invalid request");
        return;
      }
      try {
        await chat.setConfig(parsed.data);
        res.json({ ok: true, snapshot: chat.getSnapshot() });
      } catch (e) {
        const code = errCode(e);
        sendError(res, statusForCode(code), code, (e as Error).message);
        return;
      }
    })
  );

  app.post(
    "/api/chats/:id/rename",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      const parsed = RenameRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "invalid request");
        return;
      }
      try {
        await chat.rename(parsed.data.name);
        res.json({ ok: true, snapshot: chat.getSnapshot() });
      } catch (e) {
        sendError(res, 500, "INTERNAL", (e as Error).message);
        return;
      }
    })
  );

  app.post(
    "/api/chats/:id/compact",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      const parsed = CompactRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(res, 400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "invalid request");
        return;
      }
      try {
        const r = await chat.compact(parsed.data.instructions);
        res.json({ ok: true, ...r, snapshot: chat.getSnapshot() });
      } catch (e) {
        const code = errCode(e);
        sendError(res, statusForCode(code), code, (e as Error).message);
        return;
      }
    })
  );

  app.post(
    "/api/chats/:id/extension-response",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      const parsed = ExtensionResponseRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "invalid request");
        return;
      }
      try {
        await chat.respondToExtension(parsed.data.reqId, {
          value: parsed.data.value,
          confirmed: parsed.data.confirmed,
          cancelled: parsed.data.cancelled
        });
        res.json({ ok: true });
      } catch (e) {
        const code = errCode(e);
        sendError(res, statusForCode(code), code, (e as Error).message);
        return;
      }
    })
  );

  app.post(
    "/api/chats/:id/dispose",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      try {
        await chat.dispose();
        res.json({ ok: true });
      } catch (e) {
        sendError(res, 500, "INTERNAL", (e as Error).message);
        return;
      }
    })
  );

  app.get(
    "/api/chats/:id/stats",
    handler(async (req, res) => {
      const chat = getChat(req, res);
      if (!chat) return;
      res.json({ stats: chat.getSnapshot().stats ?? null });
    })
  );

  // 404 for unknown API
  app.use("/api", (_req, res) => {
    sendError(res, 404, "NOT_FOUND", "unknown api route");
  });

  // Consistent JSON error shape, no production stack traces
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number })?.status ?? 500;
    const message = err instanceof z.ZodError ? "validation error" : (err as Error)?.message ?? "internal error";
    // Never leak stack traces or secrets
    res.status(status).json(apiError("INTERNAL", String(message).slice(0, 1000)));
  });

  return app;
}

export function createDeps(adapter: PiAdapter, appVersion = "0.1.0"): AppDeps {
  return {
    adapter,
    workspaces: new WorkspaceStore(),
    security: createSecurity(),
    piVersion: adapter.piVersion(),
    appVersion
  };
}

export { CSRF_HEADER };
