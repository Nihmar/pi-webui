import { homedir } from "node:os";
import { delimiter } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sep } from "node:path";

export interface WorkspaceRecord {
  workspaceId: string;
  cwd: string;
}

export function getWorkspaceRoots(): string[] {
  const raw = process.env.WORKSPACE_ROOTS;
  const parts = raw ? raw.split(delimiter).map((s) => s.trim()).filter(Boolean) : [homedir()];
  const out: string[] = [];
  for (const p of parts) {
    try {
      const rp = realpathSync(p);
      if (existsSync(rp) && statSync(rp).isDirectory()) out.push(rp);
    } catch {
      // skip missing roots
    }
  }
  // Fallback to home if none valid
  if (out.length === 0) {
    try {
      out.push(realpathSync(homedir()));
    } catch {
      out.push(homedir());
    }
  }
  return out;
}

/** Filesystem-aware descendant check (not string-prefix). */
export function isDescendantOrEqual(candidateReal: string, rootReal: string): boolean {
  if (candidateReal === rootReal) return true;
  // Ensure root ends with sep for descendant check
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return candidateReal.startsWith(prefix);
}

export function validateWorkspacePath(inputPath: string): { cwd: string; roots: string[] } {
  const roots = getWorkspaceRoots();
  let rp: string;
  try {
    rp = realpathSync(inputPath);
  } catch {
    throw Object.assign(new Error("workspace does not exist"), { code: "NO_WORKSPACE" });
  }
  if (!existsSync(rp) || !statSync(rp).isDirectory()) {
    throw Object.assign(new Error("workspace is not a directory"), { code: "NO_WORKSPACE" });
  }
  const ok = roots.some((r) => {
    let rr = r;
    try {
      rr = realpathSync(r);
    } catch {
      /* use as-is */
    }
    return isDescendantOrEqual(rp, rr);
  });
  if (!ok) {
    throw Object.assign(new Error("workspace is outside allowed roots"), { code: "FORBIDDEN_WORKSPACE" });
  }
  return { cwd: rp, roots };
}

export class WorkspaceStore {
  private byId = new Map<string, WorkspaceRecord>();
  private byCwd = new Map<string, string>();

  open(cwdReal: string): WorkspaceRecord {
    const existing = this.byCwd.get(cwdReal);
    if (existing) {
      const rec = this.byId.get(existing);
      if (rec) return rec;
    }
    const workspaceId = randomUUID();
    const rec: WorkspaceRecord = { workspaceId, cwd: cwdReal };
    this.byId.set(workspaceId, rec);
    this.byCwd.set(cwdReal, workspaceId);
    return rec;
  }

  get(workspaceId: string): WorkspaceRecord | undefined {
    return this.byId.get(workspaceId);
  }
}
