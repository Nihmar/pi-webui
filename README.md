# pi-web-ui

Local, private, responsive web UI for the [Pi coding agent](https://pi.dev). The browser is only a control surface — Pi remains the agent and source of truth for models, auth, settings, tools, resources, and sessions.

- Pi CLI compatibility target: **0.85.1** (`@earendil-works/pi-coding-agent` pinned `--save-exact` + `package-lock.json`)
- Node: **>=22.19.0** (developed on Node v26.8.1)
- Stack: Node ESM + TypeScript (strict), Express 5, Zod, React + Vite, native SSE, `react-markdown` + `remark-gfm`, Vitest, Supertest, Playwright Chromium

## Quick start

```bash
npm ci
npm run dev        # Vite :5173 proxies /api to 127.0.0.1:4783 + tsx server watch
npm run typecheck
npm test           # Vitest (fake adapter, no model tokens)
npm run test:e2e   # Playwright Chromium (fake adapter, no model tokens)
npm run build
npm start          # production: http://127.0.0.1:4783
```

Production binds literally to `127.0.0.1`, default port `4783`. `PORT=1024–65535` override is validated; `HOST` override is rejected. On `EADDRINUSE` it exits with a clear message. It prints the exact local URL, e.g.:

```
pi-web-ui listening on http://127.0.0.1:4783 (real Pi adapter, pi 0.85.1)
```

Restart:

```bash
PORT=4783 npm start
```

To use the deterministic fake backend (tests/E2E, no Pi needed):

```bash
PI_WEBUI_USE_FAKE=1 npm start
```

## Architecture

```
browser (React) ──same-origin──> Express (one process)
  EventSource SSE /api/chats/:id/events
  fetch JSON /api/* with x-pi-csrf
        │
  WorkspaceStore (opaque workspaceId -> real cwd)
  PiAdapter (fake | real) -> ChatHandle per live chat
        │
  Real: createAgentSessionServices + createAgentSessionFromServices
        SessionManager.create/open, ModelRuntime singleton,
        DefaultResourceLoader (extensions/skills/prompts/AGENTS.md),
        AgentSession.subscribe -> normalized ServerEvent
  Fake: deterministic timers, file-backed sessions under os.tmpdir,
        same ChatHandle interface for all UI/API tests
```

- `src/shared/protocol.ts` — browser-safe Zod schemas + `ServerEvent` union (snapshot, run_status, item_added/updated, assistant/thinking delta/end, tool_start/update/end, queue_update, notice, extension_request/resolved, session_meta), URL policy (`http/https/mailto` + relative only), `truncatePreview` (4000 chars), `redactSecrets`.
- `src/server/adapter.ts` — `PiAdapter` + `ChatHandle` interface (replaceable by fake in tests).
- `src/server/fake-adapter.ts` — deterministic, no tokens. Supports stream, tools, steer/follow-up queue, abort/clear, compact, extension confirm round-trip, bounded previews, stale-event rejection via run/generation IDs, SSE replay buffer (last 200), single-writer attach.
- `src/server/real-adapter.ts` — one `createAgentSession` per live web chat (no `createAgentSessionRuntime` replacement needed for multi-chat). Uses `agent_settled` as primary settled signal with `prompt()` promise fallback; never completes on `message_end`/`agent_end`. `preflightResult` returns HTTP 202 on accept/queue. Idle sends via `prompt()`, busy via `steer()`/`followUp()`. Stop = `clearQueue()` + `abort()`, stays `stopping` until settled. Tools via `setActiveToolsByName` (readonly `read,grep,find,ls` default; full = all configured incl. extensions). Extension UI bridged with mode `rpc` (`select/confirm/input/editor/notify/setStatus`; TUI-only `custom()` returns safe fallback + notice, never auto-confirms). Passes Pi's built-in extension factories (e.g. `llama.cpp`) via `resourceLoaderOptions.extensionFactories` — the SDK omits them by default and only the CLI adds them, so without this local/extension providers would never register (resolved through public `getPackageDir()`; pinned to Pi 0.85.1).
- `src/server/app.ts` — typed routes, SSE with snapshot on connect + `Last-Event-ID` replay/resnapshot, reconcile by stable item IDs.
- `src/server/security.ts`, `workspaces.ts` — see Security below.
- `client/` — sidebar (260–300px desktop, drawer <820px with scrim/Escape/focus), controls, conversation (GFM no-raw-HTML, collapsible thinking/tools, queue, notices, autoscroll within 96px + Jump to latest), composer (growing textarea, draft persisted, Enter=send on desktop / Shift+Enter newline, Send→Stop while busy, Steer/Follow-up + queued count, config disabled while busy), extension dialogs, Connected/Reconnecting/Disconnected.

## Pi paths and state

Built in this directory (no unrelated files were present), never inside `~/.pi/agent`.

- Config/agent dir resolved via SDK `getAgentDir()` (respects `PI_CODING_AGENT_DIR`; reported as set/unset only, never dumped).
- Session storage resolved via SDK + settings precedence: `PI_CODING_AGENT_SESSION_DIR` → Pi `sessionDir` setting → Pi default (`~/.pi/agent/sessions/<encoded-cwd>/`). Never hard-coded; never derived manually when Pi can resolve.
- Chosen project = canonical `cwd` given to Pi (realpath).
- Durable chats = Pi native JSONL sessions. No transcript DB, never edit JSONL ourselves.
- `SessionManager.list/open/create` only; resume only exact paths from Pi listing. Browser gets opaque base64url session IDs; server validates against fresh listing + realpath containment under Pi session roots. Traversal/symlink escapes blocked.
- `chatId -> live Pi session`, `sessionFile -> chatId`. Second resume attaches to the existing live chat (same `chatId`), never a second writer. Cross-process leases are not claimed: do not run the same native session concurrently from another dashboard process or terminal.
- Live in-memory stream is authoritative during a run; after resume/restart snapshot rebuilt via `SessionManager.buildContextEntries()` (active branch only, not flattened). Merges use entry/message/tool-call IDs, never fuzzy text/timestamps. Stale events ignored via generation/run IDs. Restart forgets live web IDs but every saved Pi session still lists/resumes.
- Auth reused from existing Pi (`~/.pi/agent/auth.json` via `ModelRuntime`); never copied/returned/logged. No browser credential form; if no models, UI says run `pi` + `/login` locally.
- Browser storage only: UI prefs, recent workspace paths, delivery mode, unsent drafts.

## Trust

Project trust follows Pi semantics (`~/.pi/agent/trust.json`, `defaultProjectTrust: ask` default). The web UI never auto-approves trust. If protected resources are skipped, the chat stays usable with a notice, e.g.:

> Project-local resources were skipped pending trust. Approve trust by running `pi` in this project and choosing to trust it.

Context files (`AGENTS.md`/`CLAUDE.md`) load per Pi rules regardless of trust unless disabled. Use `pi --approve/-a` or `--no-approve/-na` for one-run overrides in the terminal, not the browser.

## Local models (llama.cpp)

Pi talks to a local [llama.cpp router server](https://github.com/ggml-org/llama.cpp) (`llama-server` in router mode — started **without** `--model`/`-m`/`-hf`):

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 127.0.0.1 \
  --port 8080 \
  -ngl 999 \
  -c 32768
```

Single `.gguf` files sit directly in `--models-dir`; multimodal/multi-shard models each in their own subdirectory. Restart the router after adding files by hand. Keep `--host 127.0.0.1` (local-only). Any port works — this machine uses `8181` (`llama serve`); just point Pi at whatever you chose. Check reachability with `curl http://127.0.0.1:<port>/health` and `/models`.

Point Pi at it (once, in any terminal — the dashboard reuses the same stored auth, no browser login):

```text
pi
/login llama.cpp
```

Enter the exact router URL, e.g. `http://127.0.0.1:8181` (no trailing slash); API key only if the server uses `--api-key`. Then `/llama` (load/unload, download from Hugging Face) and `/model` (only *loaded* models appear — select one). Alternative without stored login: `export LLAMA_BASE_URL=http://127.0.0.1:8181` in the **same** shell that runs the dashboard (env vars don't cross terminals; stored `/login` is preferred).

Dashboard notes: the Model dropdown lists Pi's authenticated models including `llama.cpp/...` — reopen the workspace to refresh after `/login`. Set Thinking to `off` (local models report no reasoning; Pi clamps anyway). If selecting a model errors, load it first via `/llama` in terminal `pi`.

Known quirks (Pi 0.85.1, not this app): `pi auth check --provider llama.cpp` reports `provider_not_found` because that command path doesn't load extensions — ignore it and trust `/llama` + the dashboard dropdown instead. The server loads Pi's built-in provider extension explicitly (see Architecture); without that, `llama.cpp` models never appear even with correct login.

## Security

**Pi has no built-in sandbox and runs with the permissions of its host user.** Built-in tools, extensions, and shell commands are ordinary local processes. Tailscale controls network access; it does not sandbox Pi. For untrusted repos or unattended work, run the whole dashboard inside a container/VM/micro-VM with only needed files/credentials, review diffs before copying back. See `https://pi.dev/docs/latest/security` and `containerization`.

- Binds only `127.0.0.1`. No `HOST` override, no `0.0.0.0`, no CORS, no CDN assets. Helmet CSP (`default-src 'self'`), `Referrer-Policy: no-referrer`.
- Per-process random CSRF token in `GET /api/bootstrap`, required as `x-pi-csrf` on every mutation. Clearly cross-site `Origin`/`Sec-Fetch-Site: cross-site` rejected. Only loopback `Host` + explicitly configured Tailscale Serve hostnames allowed (`ALLOWED_HOSTS` / `TAILSCALE_SERVE_HOSTS`, comma-separated). Forwarded host/proto trusted only when the immediate proxy connection is loopback (which holds because we bind localhost-only behind Serve). Localhost and Serve HTTPS origins both work.
- Workspace roots from `WORKSPACE_ROOTS` (platform `path.delimiter`-separated; default home). Roots and candidates realpath-canonicalized, must be existing directories, filesystem-aware descendant checks (not string prefix). To add `/Volumes`, mounted disks, or other roots: `WORKSPACE_ROOTS="/home/user:/Volumes/Data:/mnt/disk" npm start`.
- Small explicit JSON limit (`256kb`), Zod validation, consistent `{ error: { code, message } }`, no stack traces. Tool previews bounded (4000 chars), display payloads bounded, non-Markdown fields escaped, secrets redacted (never log/return keys, tokens, auth headers, env, `.env`, private keys, arbitrary files). No shell-execution endpoints; coding goes through Pi tools.
- Optional `ALLOWED_TAILSCALE_USERS="alice,bob"` compared against `Tailscale-User-Login` for remote (non-loopback effective host) requests. Trustworthy only because the backend stays localhost-only behind Serve.
- No public hosting, telemetry, analytics, share buttons, or Tailscale Funnel.

## Tailscale Serve (private, no auto-commands)

After localhost works, in a separate terminal (commands are manual, never auto-run):

```bash
tailscale serve --bg http://127.0.0.1:4783
tailscale serve status
```

If `PORT` changed, substitute it. Serve provides a private tailnet HTTPS URL. Both devices must be in the same tailnet; restrict via ACLs/grants to the owner; never use Funnel. `--bg` persists the proxy config across Tailscale restarts/reboots but does not start this Node app — the host must be powered on, awake, online, and Tailscale-connected, and `npm start` must be running.

If using a Serve hostname, allow it:

```bash
ALLOWED_HOSTS="myhost.tail123.ts.net" npm start
```

## Optional autostart (ask once, default manual)

The dashboard runs when `npm start` is active. `tailscale serve --bg` keeps the proxy config, not the app.

> The dashboard currently runs when `npm start` is active. Do you want me to install an OS-native user service so it starts automatically and restarts after a crash?

Only on explicit yes, using the native manager (no global process-manager dep):

- macOS: user LaunchAgent `~/Library/LaunchAgents/pi-web-ui.plist` with `RunAtLoad` + `KeepAlive`, absolute cwd + absolute `node` + `dist/server/index.js`, `PORT`/`WORKSPACE_ROOTS`/`ALLOWED_HOSTS` preserved (no secrets), logs to app-local `logs/` with rotation note. Verify via restart + `/api/health` + model availability. Provide status/stop/restart/disable/uninstall (`launchctl`).
- Linux: `systemd --user` unit `~/.config/systemd/user/pi-web-ui.service` with `Restart=on-failure`, `WantedBy=default.target`, same absolute paths/env (no secrets). If headless before-login needed, lingering is a separate system choice — ask before `loginctl enable-linger`. Provide `systemctl --user status/stop/restart/disable`.
- Windows: per-user Task Scheduler entry at sign-in with restart-on-failure, absolute paths.

Before installing, check (without printing values) whether Pi auth depends on shell-only env vars; if so, use Pi stored `/login` auth or OS-native secrets, never copy secrets into the service. Manual `npm start` keeps working either way.

If declined: no machine changes; manual start + optional setup stay documented here.

### Installed on this machine (Linux, systemd user service)

```bash
systemctl --user status pi-web-ui    # status
systemctl --user restart pi-web-ui   # restart
systemctl --user stop pi-web-ui      # stop (manual `PORT=4783 npm start` still works)
systemctl --user disable --now pi-web-ui   # disable autostart + stop
systemctl --user disable pi-web-ui && rm ~/.config/systemd/user/pi-web-ui.service  # uninstall
tail -f logs/pi-web-ui.log           # logs (gitignored; truncate when large)
```

- Unit: `~/.config/systemd/user/pi-web-ui.service` (`Restart=on-failure`, absolute `/usr/bin/node` + `dist/server/index.js`, `PORT=4783`, `WORKSPACE_ROOTS=/home/alessandro:/tmp`, `ALLOWED_HOSTS=cachyos-fisso.pig-diatonic.ts.net`, no secrets — Pi auth is the user's stored `/login`).
- Serve: `https://cachyos-fisso.pig-diatonic.ts.net` → `http://127.0.0.1:4783` (`tailscale serve --bg`, `tailscale serve status`).
- User lingering is **not** enabled: the service starts at login, not boot. Ask before `loginctl enable-linger` on a headless host.

## Troubleshooting

- `Port 4783 is already in use` → stop the other process or `PORT=5000 npm start` (1024–65535).
- `workspace is outside allowed roots` → set `WORKSPACE_ROOTS` to include it (see Security).
- `host not allowed` → add Serve hostname to `ALLOWED_HOSTS`.
- `missing or invalid CSRF token` → `GET /api/bootstrap` first; mutations need `x-pi-csrf`.
- `No authenticated model` → run `pi` + `/login` locally; no browser login form by design.
- `llama.cpp` models missing from the dropdown → complete `/login llama.cpp` with the exact router URL (terminal `pi`), then reopen the workspace in the dashboard. `pi auth check --provider llama.cpp` saying `provider_not_found` is a Pi CLI quirk — ignore it.
- `llama.cpp` model errors on send → load it first via `/llama` in terminal `pi` (only loaded models run), then resend.
- Router unreachable (`/llama` shows Retry/Close) → check `curl <url>/health`, `--models-dir` layout, router-mode start (no `--model`), and restart the router.
- `session is already open` → second resume attaches to the same live `chatId` (no second writer); use that chat.
- Empty new sessions may not list until the first message (Pi persists on first append).
- `SDK initialization failure` / model errors surface as actionable notices in the conversation, not silent failures.

## Tests (no model tokens by default)

```bash
npm test          # 36 Vitest: containment+symlinks+prefix traps, opaque validation,
                  # attach/no-second-writer, active-branch, normalization, bounded previews,
                  # reconciliation, stale rejection, queue/abort/settled, SSE replay,
                  # extension round-trips, CSRF/origin (local + Tailscale-proxied),
                  # malicious markdown/schemes, limits, redaction
npm run test:e2e  # Playwright Chromium only: desktop new/send/stream/tool/stop,
                  # resume, mobile drawer/composer/stream, reconnect (no dupes), focus
```

Opt-in real-Pi smoke (never runs by default, sends no prompts):

```bash
npm run build && npm run smoke:real -- /path/to/project
```

## Intentionally omitted

Profiles, voice/transcription, `/btw`, side agents, browser editing of Pi auth/settings/trust/packages/resources, remote filesystem browser/editor, direct provider APIs, alternative DB, full session tree/fork UI, public/cloud deploy, telemetry — per scope. New/Resume/Rename/Compact/model/thinking/tools are web actions; other TUI-only commands are not pretended to work (slash menu sends through Pi prompt expansion; unsupported extension UI shows a notice).

## Files created

`package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore`, `src/shared/protocol.ts`, `src/server/{adapter,fake-adapter,real-adapter,app,security,workspaces,index,dev}.ts`, `client/{index.html,src/main.tsx,src/App.tsx,src/api.ts,src/markdown.tsx,src/styles.css}`, `tests/{workspaces,protocol,fake-adapter,server}.test.ts`, `playwright/{desktop,mobile}.spec.ts`, `scripts/real-pi-smoke.mjs`, `README.md`.
