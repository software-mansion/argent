# native-devtools-vega

An on-device command agent that makes Argent's control of **Vega (Fire TV)** virtual
devices ~300× faster than the status quo.

It ships a tiny static Rust binary (`argent-vega-agent`) that runs **on the Vega device**
and exposes an HTTP API for input injection and UI inspection. Argent reaches it over a
single `adb forward`, so per-command cost drops from ~1.8s to a few milliseconds.

---

## Why this exists

Before this package, every Vega interaction shelled out per call through the `vega` CLI
(`vega device run-cmd -c '…'`, app-lifecycle subcommands). Each invocation pays a
**~1.6–1.8s vda handshake**. For anything interactive — D-pad navigation, typing, multi-step
flows — that handshake dominates and makes the device painful to drive.

iOS and Android don't have this problem: they talk to a long-lived server (the host-side
`simulator-server`, and on Android an on-device helper reached over an `adb`-forwarded
socket). Vega had no equivalent. This package is that equivalent.

### What we measured (on a live VVD)

While prototyping we profiled the actual cost, and the result reshaped the design:

| Path | Per D-pad press |
| --- | --- |
| `vega device run-cmd` (old path) | **~1800 ms** |
| `adb shell 'inputd-cli …'` (skip vda) | ~360 ms |
| agent, fork `inputd-cli` per call | ~360 ms |
| **agent, held-open `inputd-cli` REPL + short hold** | **~3–6 ms** |

Two findings drove the architecture:

1. **`adb shell` reaches the VVD directly.** `adb -s emulator-<consolePort> shell '<cmd>'`
   runs as the *same* unprivileged `app_user` (uid 5000) that `vega run-cmd` uses, but
   round-trips in ~30 ms instead of ~1.8s. So just dropping vda in favor of `adb` is already
   a ~50× win — which is why `adb` is kept as a first-class fallback (see below).

2. **The remaining cost is `inputd-cli`, not the transport.** `inputd-cli` bakes a ~270 ms
   "short" press *hold* into every `button_press`, and pays connection setup on each fork.
   `inputd-cli button_press KEY_X --holdDuration 1` is ~53 ms. And `inputd-cli start` is an
   interactive REPL. Holding **one** REPL process open and piping
   `button_press <key> holdDuration 1` per key amortizes setup and removes the hold, landing
   at ~3–6 ms/key. **This — not the HTTP transport — is the agent's core advantage over a
   plain `adb shell`.** Focus movement at `holdDuration 1` was verified by diffing
   `selectFunction` in `getPageSource` before/after.

   (`adb shell` reaching the VVD directly is ~30 ms/op — a fine *floor* and what the transport
   was first prototyped against — but the integrated transport is **agent-only**: no adb /
   vega-cli fallback. If the agent can't be brought up, the call fails rather than silently
   running ~50–500× slower. A dropped connection is self-healed by restarting the agent once.)

---

## Design decisions (and why)

- **Agent-only, no fallback.** `adb shell` alone would get ~50× and was the original prototype
  target, but the integrated transport uses *only* the agent: it adds the last order of
  magnitude by holding the `inputd-cli` REPL open (no per-press fork, no 270 ms hold) and by
  proxying `getPageSource` in-process. Deliberately there is no adb / vega-cli fallback — a
  silent drop to a ~50–500× slower path hides real breakage, so a call instead fails loudly if
  the agent can't start. A dead agent (tmpfs wipe, OOM, manual kill) is restarted once,
  transparently, on the next command.

- **Held-open `inputd-cli start` REPL instead of reverse-engineering injection.** `inputd-cli`
  injects through a priority `inputmgr` injection point via `libevdev` over Amazon's `aipc`.
  Re-implementing that in Rust would be brittle and slow to build. The REPL gives us the same
  result with a stable, supported interface — spawn once, write a line per key, read the
  `Injecting …` confirmation for sync. A reader thread + `mpsc` channel provides per-command
  acknowledgement and lets us respawn the REPL if it dies.

- **Rust, std-only + `serde_json`, static `aarch64-unknown-linux-musl`.** The binary must run
  on the device (aarch64 Linux), not the host — the inverse of `simulator-server`. A fully
  static musl build has no runtime dependencies on the device. We link with the toolchain's
  bundled `rust-lld` (see `agent/.cargo/config.toml`) so **no external cross-gcc is required**
  on macOS build hosts. `serde_json` is the only dependency; the HTTP/1.1 server is hand-rolled
  (a request loop is ~100 lines and avoids pulling a web framework into a static binary).

- **`holdDuration 1` as the default press.** The inputd default (~270 ms) is a 50× tax for no
  navigation benefit. `1 ms` moves focus reliably for D-pad keys. *Open item:* confirm
  `KEY_ENTER`/select fires reliably at `holdDuration 1`; it may warrant a larger default. The
  `button` op accepts a per-call `holdMs` override for exactly this.

- **Fixed device port (8384), host port via `adb forward tcp:0`.** Mirrors the existing Vega
  automation toolkit's fixed `8383`, so we don't have to scrape a port from logs. The host
  side lets `adb` pick a free local port and parses it back — the same pattern as
  `blueprints/android-devtools.ts`.

- **Deployment streams base64 through `adb shell` stdin.** `adb push` and `vega device copy-to`
  **both fail** to write `/scratch` — that daemon lands in a different, read-only mount
  namespace. `/scratch` is writable and non-`noexec` from an interactive shell, so we deploy
  with `base64 < bin | adb shell 'base64 -d > /scratch/argent-vega-agent && chmod +x …'`. The
  binary lives in tmpfs, so a deploy-if-missing checksum probe (Phase 1) re-pushes it after a
  device reboot.

- **HTTP error envelope, not HTTP status codes, for logical errors.** `/cmd` returns HTTP 200
  with `{"ok":false,"error":{type,message}}` for command-level failures; non-200 is reserved
  for transport faults. This matches the `android-devtools-client` convention.

---

## Architecture

```
Argent (host, Node/TS)                          Vega VVD (aarch64 Linux, app_user)
┌───────────────────────────┐                   ┌──────────────────────────────────────┐
│ resolveVegaTransport()     │                   │  argent-vega-agent  (this package)     │
│  └─ agent (~3ms) ──────────┼── HTTP/1.1 ───────┼─▶ 127.0.0.1:8384                       │
│     (no fallback)          │   over            │     ├─ POST /cmd button/text ──┐       │
│                            │   adb forward     │     │                          ▼       │
│ vega-agent-manager         │   tcp:0→tcp:8384  │     │   held-open `inputd-cli start`   │
│  deploy · forward · health │                   │     │   REPL (one process, piped)      │
│  · restart-on-death        │                   │     └─ POST /cmd getPageSource ─▶ :8383 │
└───────────────────────────┘                   │         (on-device automation toolkit) │
                                                 └──────────────────────────────────────┘
```

- **`agent/`** — the Rust crate (`argent-vega-agent`).
- The TS integration lives in `packages/tool-server/src/utils/`: `vega-transport.ts`
  (agent-only transport), `vega-agent-manager.ts` (lifecycle singleton, not a registry
  blueprint), `vega-agent-client.ts`, `vega-agent-install.ts`, `vega-agent-assets.ts`. The
  `remote` and `keyboard` tools route through it; teardown is wired into
  `stop-all-simulator-servers`.

---

## Wire protocol

HTTP/1.1, keep-alive, JSON bodies.

| Method / path | Body | Response |
| --- | --- | --- |
| `GET /ping` | — | `{"ok":true,"version":"0.1.0","protocol":"vega-agent/1"}` |
| `POST /cmd` | `{"op":"button","args":{"keys":["KEY_UP","KEY_ENTER"],"holdMs":1}}` | `{"ok":true,"result":{"pressed":2}}` |
| `POST /cmd` | `{"op":"text","args":{"text":"hello"}}` | `{"ok":true,"result":{"chars":5}}` |
| `POST /cmd` | `{"op":"getPageSource","args":{}}` | `{"ok":true,"result":{"xml":"<…>"}}` |
| `POST /cmd` | `{"op":"shell","args":{"cmd":"…","timeoutMs":5000}}` | `{"ok":true,"result":{"stdout,"stderr","exit"}}` |
| `POST /shutdown` | — | `{"ok":true}` then exits |

`/ping.version` + `protocol` drive the host's version-skew / redeploy check. `shell` is an
internal escape hatch (debugging/lifecycle), not a general tool surface.

---

## Building & running (manual / prototype)

```sh
# Build the static device binary (host: macOS or Linux)
cd agent
rustup target add aarch64-unknown-linux-musl   # once
cargo build --release --target aarch64-unknown-linux-musl

# Deploy to the VVD (adb push to /scratch does NOT work — use base64 over stdin)
BIN=target/aarch64-unknown-linux-musl/release/argent-vega-agent
base64 < "$BIN" | adb -s emulator-5554 shell \
  'base64 -d > /scratch/argent-vega-agent && chmod +x /scratch/argent-vega-agent'

# Start detached on the device, then bridge a host port to it
adb -s emulator-5554 shell \
  'setsid /scratch/argent-vega-agent --port 8384 >/scratch/agent.log 2>&1 </dev/null &'
adb -s emulator-5554 forward tcp:0 tcp:8384      # prints the host port, e.g. 64215

# Drive it
curl -s localhost:<hostPort>/ping
curl -s -XPOST localhost:<hostPort>/cmd -d '{"op":"button","args":{"keys":["KEY_DOWN"]}}'
```

The agent CLI: `--port <n>` (default 8384), `--version` (prints `argent-vega-agent <v>` and
exits — used by the host's deploy-if-missing probe).

---

## Security / sandbox notes

- The agent runs as the unprivileged `app_user` (uid 5000) inside the device's minijail
  sandbox: **zero Linux capabilities**, cannot remount or escalate. It is code execution
  *within* the sandbox, the same surface a normal Vega app already has — not a jailbreak.
- `button` keycodes are whitelisted to `^[A-Z0-9_]+$` and never reach a shell. `text` rejects
  embedded newlines (the REPL is line-oriented). Only the internal `shell` op and the base64
  deploy step touch a shell; the host quotes those and guards the emulator serial.
- This targets the **virtual** device. A retail Fire TV with production secure-boot/policy may
  not permit `/scratch` execution or a dev shell — don't assume parity.

---

## Status

- **Phase 0 (this package's `agent/`): done & validated on a live VVD** — agent runs, survives
  a detached shell, HTTP over `adb forward` works; `button` (~3–6 ms, focus moves), `text`, and
  `getPageSource` all verified.
- **Phase 1 (landed): agent-only transport.** `resolveVegaTransport` + `vega-agent-manager`
  (deploy-if-missing, start, forward, health, restart-on-death) in `packages/tool-server`; the
  `remote`, `keyboard`, and `describe` tools route through it; teardown in
  `stop-all-simulator-servers`. Typechecks and verified end-to-end against the live VVD (agent
  backend + transparent restart on a killed agent). No adb/vega-cli fallback — agent-only by
  design.
- **`describe` routes through the agent (landed).** `getPageSource` now comes over the
  keep-alive agent socket instead of a per-call `adb forward` + fresh `fetch`; the dead
  host-side JSON-RPC path (`vegaJsonRpc` / `fetchVegaPageSource`) was removed. The toolkit
  enable flag stays owned by `launch-app` / `restart-app` (only read at app launch). Verified
  on the live VVD: 7 KB page source parsed to a full tree, **steady-state ~2–5 ms** per fetch
  (was tens–hundreds of ms). (`list-installed-apps`: still on the legacy path — route too if
  convenient, lower value.)

### Before this ships

- **Bundle the binary + manifest into the published `argent` package.** Today
  `vega-agent-assets.ts` resolves them by repo-relative path / `ARGENT_VEGA_AGENT_*` env
  override, which only holds in a source checkout. In the published package that path is gone,
  so deploy throws and — with no fallback by design — the whole Vega input path is dead for end
  users. This is a release blocker, not a nice-to-have.

### Verify / later

- `KEY_ENTER`/select at `holdMs 1` (agent default): **verified reliable** on the VVD (OS 1.1
  TV Ship). 5/5 activations landed via the agent path — tile→detail, the `Watch now` playback
  button, and `select` as the terminal key of a batched `["right","right","left","left",
  "select"]` path. No misses, no need to bump the hold. Re-check on retail hardware if parity
  is ever needed.
- `touch`/`swipe` ops only if Vega ever needs pointer input — speculative; Vega is
  D-pad-navigated, so not planned.
