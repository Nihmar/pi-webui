import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDescendantOrEqual, validateWorkspacePath, getWorkspaceRoots } from "../src/server/workspaces.ts";

describe("workspace containment", () => {
  let root: string;
  let a: string;
  let abTrap: string;
  let linkDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ws-root-"));
    a = join(root, "proj");
    abTrap = join(root, "proj-evil");
    mkdirSync(a, { recursive: true });
    mkdirSync(abTrap, { recursive: true });
    process.env.WORKSPACE_ROOTS = a;
  });
  afterEach(() => {
    delete process.env.WORKSPACE_ROOTS;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
    try {
      if (linkDir) rmSync(linkDir, { recursive: true, force: true });
    } catch {}
  });

  it("allows descendant directories", () => {
    const sub = join(a, "sub", "dir");
    mkdirSync(sub, { recursive: true });
    const { cwd } = validateWorkspacePath(sub);
    expect(cwd.length).toBeGreaterThan(0);
  });

  it("rejects path-prefix traps (proj vs proj-evil)", () => {
    expect(() => validateWorkspacePath(abTrap)).toThrow();
  });

  it("rejects symlink escapes outside roots", () => {
    const outside = mkdtempSync(join(tmpdir(), "ws-out-"));
    linkDir = outside;
    const link = join(a, "link-out");
    try {
      symlinkSync(outside, link);
    } catch {
      return; // symlink not permitted on platform; skip
    }
    expect(() => validateWorkspacePath(link)).toThrow();
  });

  it("resolves symlinks inside roots", () => {
    const realSub = join(a, "real");
    mkdirSync(realSub, { recursive: true });
    const link = join(a, "link-in");
    try {
      symlinkSync(realSub, link);
    } catch {
      return;
    }
    const { cwd } = validateWorkspacePath(link);
    expect(cwd).toContain("real");
  });

  it("isDescendantOrEqual is filesystem-aware, not string prefix", () => {
    expect(isDescendantOrEqual("/tmp/foobar", "/tmp/foo")).toBe(false);
    expect(isDescendantOrEqual("/tmp/foo/bar", "/tmp/foo")).toBe(true);
    expect(isDescendantOrEqual("/tmp/foo", "/tmp/foo")).toBe(true);
  });

  it("defaults to home when WORKSPACE_ROOTS unset", () => {
    delete process.env.WORKSPACE_ROOTS;
    const roots = getWorkspaceRoots();
    expect(roots.length).toBeGreaterThan(0);
  });
});
