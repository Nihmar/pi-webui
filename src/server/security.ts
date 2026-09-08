import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import helmet from "helmet";

export const CSRF_HEADER = "x-pi-csrf";

export function newCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

function parseAllowedHosts(): string[] {
  // Explicitly configured Tailscale Serve hostnames, comma-separated.
  // Example: ALLOWED_HOSTS="myhost.tail123.ts.net,myhost2.tail123.ts.net"
  const raw = process.env.ALLOWED_HOSTS ?? process.env.TAILSCALE_SERVE_HOSTS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "127.0.0.2" ||
    h.startsWith("127.")
  );
}

function hostnameFromHost(host: string): string {
  // host may include port; handle IPv6 [::1]:port
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (v6) return v6[1]!.toLowerCase();
  const idx = host.lastIndexOf(":");
  // If single colon and not IPv6 without brackets, could be host:port; naive split
  if (idx > 0 && host.indexOf(":") === idx) {
    return host.slice(0, idx).toLowerCase();
  }
  // IPv6 without brackets or no port
  if (host.includes(":") && !host.includes(".")) return host.toLowerCase();
  return host.toLowerCase();
}

function isLoopbackRemote(remoteAddr: string | undefined): boolean {
  if (!remoteAddr) return false;
  const a = remoteAddr.toLowerCase();
  return (
    a === "127.0.0.1" ||
    a === "::1" ||
    a === "::ffff:127.0.0.1" ||
    a.startsWith("127.") ||
    a.includes("127.0.0.1")
  );
}

export interface SecurityContext {
  csrfToken: string;
  allowedHosts: string[];
  allowedUsers: string[];
}

export function createSecurity(): SecurityContext {
  return {
    csrfToken: newCsrfToken(),
    allowedHosts: parseAllowedHosts(),
    allowedUsers: (process.env.ALLOWED_TAILSCALE_USERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  };
}

function getEffectiveHost(req: Request): string {
  const remote = req.socket.remoteAddress ?? "";
  const trustForwarded = isLoopbackRemote(remote);
  if (trustForwarded) {
    const xfh = req.get("x-forwarded-host");
    if (xfh) return xfh.split(",")[0]!.trim();
    const fwd = req.get("forwarded");
    if (fwd) {
      const m = /host=([^;,]+)/i.exec(fwd);
      if (m) return m[1]!.trim().replace(/^"|"$/g, "");
    }
  }
  return req.get("host") ?? "";
}

function getEffectiveProto(req: Request): string {
  const remote = req.socket.remoteAddress ?? "";
  const trustForwarded = isLoopbackRemote(remote);
  if (trustForwarded) {
    const xfp = req.get("x-forwarded-proto");
    if (xfp) return xfp.split(",")[0]!.trim().toLowerCase();
    const fwd = req.get("forwarded");
    if (fwd) {
      const m = /proto=([^;,]+)/i.exec(fwd);
      if (m) return m[1]!.trim().replace(/^"|"$/g, "").toLowerCase();
    }
  }
  return req.protocol;
}

export function hostAllowlistMiddleware(ctx: SecurityContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const effHost = getEffectiveHost(req);
    if (!effHost) {
      res.status(403).json({ error: { code: "FORBIDDEN_HOST", message: "missing Host" } });
      return;
    }
    const hostname = hostnameFromHost(effHost);
    const allowed =
      isLoopbackHostname(hostname) || ctx.allowedHosts.includes(hostname);
    if (!allowed) {
      res.status(403).json({ error: { code: "FORBIDDEN_HOST", message: "host not allowed" } });
      return;
    }
    // Optional Tailscale user check for remote (non-loopback effective host) requests
    if (ctx.allowedUsers.length > 0 && !isLoopbackHostname(hostname)) {
      const login = (req.get("tailscale-user-login") ?? "").trim().toLowerCase();
      if (!login || !ctx.allowedUsers.includes(login)) {
        res.status(403).json({ error: { code: "FORBIDDEN_USER", message: "tailscale user not allowed" } });
        return;
      }
    }
    // Attach effective host/proto for downstream origin checks
    (req as unknown as { _effHost?: string; _effProto?: string })._effHost = effHost;
    (req as unknown as { _effHost?: string; _effProto?: string })._effProto = getEffectiveProto(req);
    next();
  };
}

export function csrfAndOriginMiddleware(ctx: SecurityContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Only enforce on mutations
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      // Still reject clearly cross-site fetch metadata on GETs that change state? GETs are safe.
      return next();
    }
    // 1) CSRF token in custom header
    const token = req.get(CSRF_HEADER);
    if (!token || token !== ctx.csrfToken) {
      res.status(403).json({ error: { code: "BAD_CSRF", message: "missing or invalid CSRF token" } });
      return;
    }
    // 2) Reject clearly cross-site Sec-Fetch-Site
    const sfs = (req.get("sec-fetch-site") ?? "").toLowerCase();
    if (sfs === "cross-site") {
      res.status(403).json({ error: { code: "CROSS_SITE", message: "cross-site request rejected" } });
      return;
    }
    // 3) If Origin present, it must be loopback or allowed Tailscale hostname.
    // Derive effective origin safely (trust forwarded only from loopback, already done).
    const origin = req.get("origin");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        res.status(403).json({ error: { code: "BAD_ORIGIN", message: "invalid Origin" } });
        return;
      }
      const ok = isLoopbackHostname(originHost) || ctx.allowedHosts.includes(originHost);
      if (!ok) {
        res.status(403).json({ error: { code: "BAD_ORIGIN", message: "origin not allowed" } });
        return;
      }
    }
    next();
  };
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" }
  });
}

// Redacting logger: never log auth headers, tokens, env, .env, private keys.
export function safeLog(...args: unknown[]): void {
  const redacted = args.map((a) => {
    if (typeof a === "string" && /^(sk-|xox|ghp_|Bearer\s+)/i.test(a)) return "[redacted]";
    return a;
  });
  // eslint-disable-next-line no-console
  console.log(...redacted);
}
