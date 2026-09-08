/**
 * Opt-in real-Pi smoke checklist (never runs by default, never sends model prompts).
 *
 * Usage:
 *   npm run smoke:real -- /path/to/project
 *
 * What it does (no model tokens, no prompts):
 *   1. Prints Pi version + agent dir status (set/unset only, never values).
 *   2. Opens the workspace via RealAdapter (validates WORKSPACE_ROOTS).
 *   3. Lists authenticated models (count + provider/id only).
 *   4. Lists native Pi sessions for the cwd.
 *   5. Creates a new native session and immediately disposes it (no prompt sent).
 *
 * If step 5 creates an empty session, Pi may not persist it until the first
 * message (expected SDK behavior); the script reports this instead of failing.
 * Do NOT extend this script to send prompts by default.
 */
import { RealAdapter } from "../dist/server/real-adapter.js";

const cwd = process.argv[2] ?? process.cwd();
const adapter = new RealAdapter();
console.log(`piVersion: ${adapter.piVersion()}`);
console.log(`PI_CODING_AGENT_DIR: ${process.env.PI_CODING_AGENT_DIR ? "set" : "unset"}`);
console.log(`PI_CODING_AGENT_SESSION_DIR: ${process.env.PI_CODING_AGENT_SESSION_DIR ? "set" : "unset"}`);

const ws = await adapter.openWorkspace(cwd);
console.log(`cwd: ${ws.cwd}`);
console.log(`models: ${ws.models.length}`);
for (const m of ws.models.slice(0, 10)) console.log(`  - ${m.provider}/${m.id}`);
if (ws.models.length === 0) console.log("  (none) run `pi` and `/login` locally");
console.log(`sessions: ${ws.sessions.length}`);
for (const s of ws.sessions.slice(0, 5)) {
  console.log(`  - ${s.name ?? s.firstMessage?.slice(0, 60) ?? "(unnamed)"} [${s.messageCount ?? "?"} msgs]`);
}
console.log(`diagnostics: ${ws.diagnostics.join(" | ")}`);
if (ws.trustNotice) console.log(`trustNotice: ${ws.trustNotice}`);

const chat = await adapter.createChat("smoke", ws.cwd, "smoke-test");
console.log(`created live chat ${chat.chatId} -> ${chat.getSessionFile() ?? "(no file yet)"}`);
console.log(`snapshot items: ${chat.getSnapshot().items.length}`);
await chat.dispose();
console.log("disposed. Smoke OK (no prompts sent, no tokens spent).");
console.log("Note: empty sessions may not appear in listings until the first message (Pi SDK behavior).");
