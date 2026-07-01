# Nickel — Argent's little brother (local-model minion)

**Nickel** is a local VLM (Gemma 4 E4B) harnessed as a capable UI worker and exposed
as argent tools. Silver's cheap, hard-wearing companion: it does the small change —
navigation, clicking, typing, gestures, visual understanding, and error recovery —
so the frontier can stay at altitude and reach for the heavy tools (profiling, repro,
debugging) itself.

## Principles

1. **A worker, not a proxy.** Nickel makes decisions, recovers from errors, and can
   run a goal autonomously — not just relay one tool call.
2. **Dispatched THROUGH argent, not around it.** Nickel is a first-class argent
   capability (tools + a runtime blueprint), reached via argent's own MCP. It calls
   argent's other tools **in-process through the registry** — no duplication, no HTTP hop.
3. **Optional and additive.** Feature-flagged, off by default; argent works unchanged
   with or without it.
4. **Frontier owns the session; Nickel owns the moment.** Nickel is stateful only for
   the duration of one `do` run; the **device screen is the durable state** (it always
   re-observes), so there is no session store in Nickel.
5. **Two systems.** S1 = fast reflex grounding (reasoning off, schema-constrained). S2
   = deliberation / recovery / verification (reasoning on, may use vision).

## Tool surface

- **`nickel_act(instruction)`** — one mundane action (pure S1: ground + execute). Stateless.
- **`nickel_do(goal, context?)`** — autonomously pursue a goal (S1+S2 loop, ephemeral
  goal-scoped state, uses vision when needed). Returns a protocol result (below).
- **`nickel_look(question?)`** — inspect / answer about the current screen (may use vision).

Resume after `need_clearance`/`blocked` = the frontier re-dispatches `nickel_do` with
context; Nickel re-observes and continues. No `start`/`continue`, no session id.

## Protocol (two-way comms)

Every result carries a **common envelope** for situational awareness:

```ts
{ status, goal, summary, screen: string[] /* on-screen labels */,
  trace:[{i,thought?,action,outcome}], cost:{steps,model_calls,ground_ms,exec_ms,used_vision} }
```

Status-specific payloads (the "with what / by what" the frontier needs):

```ts
done:           { achieved, evidence }
need_clearance: { proposed_action:{kind,target?}, why, risk, reversible, resume_hint }
blocked:        { obstacle, likely_cause, tried:[{action,outcome}], ask }
report:         { note, continue }
```

`risk ∈ { destructive, irreversible, purchase, external }`. Nickel raises
`need_clearance` _before_ risky/irreversible actions and `blocked` after its own
recovery attempts fail — always with the trace of what it tried.

## Vision (leveraged, not fallback-only)

Gemma 4 E4B is a real VLM. Nickel uses it by judgment, not by default:

- **S1 grounding:** AX tree first (fast, exact); fall to `screenshot` + **Set-of-Mark**
  (numbered elements → pick an id) when the tree is thin/ambiguous or a tap didn't land.
- **S2:** `look` at pixels to verify ("did the thread open?"), understand canvas/WebView
  content the tree can't describe, or diagnose a `blocked`.
  The runtime loads the Gemma 4 **mmproj** so vision is always available; `cost.used_vision`
  records when it fired.

## Architecture (mirrors argent's structure)

```
packages/nickel/                       self-contained, iterable in isolation
  src/
    tools/     nickel-act.ts  nickel-do.ts  nickel-look.ts    ToolDefinitions (kebab ids)
    runtime/   llama-runtime.ts (blueprint: health/teardown)  client.ts (OpenAI-compat)
    grounding/ ground.ts (System 1: tree+instruction→ToolCall)
               deliberate.ts (System 2: goal+screen+history→plan, thought-first)
    act/       execute.ts (grounded ToolCall → argent tool, the ONE action site)
               risk.ts    (deterministic risk floor → forces need_clearance)
    describe/  screen.ts  (tree text → normalized El/Screen — the shared contract)
    protocol.ts   (done|need_clearance|blocked|report union + Envelope/Cost/Trace)
    register.ts   (registerNickel(registry) — the ONE integration seam)
  bin/          packaged llama-runtime (future: downloaded like simulator-server)

INTEGRATION: @argent/tool-server setup-registry.ts gains one line:
   registerNickel(registry)
All three tools declare featureFlag:"nickel", so (like argent-lens) they are gated at
the exposure boundary: hidden from GET /tools and rejected on invocation while the
flag is off, live on the next request after `argent enable nickel` — no restart.
Nickel reaches describe / gesture-tap / screenshot / await-ui-element THROUGH the
registry in-process. The runtime blueprint manages llama-server, lazy-spawned on first
use, torn down on idle — same lifecycle as ax-service / simulator-server.
```

## Runtime constraints already known (carried over)

Gemma-4 reasoning off for S1 · flat-enum schema (oneOf+strict stalls) · normalized 0..1
coords shared with argent · trust `describe` over stale screencaps · llama-server needs
a latency watchdog (degrades over long sessions) · role-aware resolve (AXButton vs
AXStaticText; Android roles lack `AX`).

## Build phases (keep a working thing at each step)

0. **[DONE] Skeleton + seam.** `packages/nickel` layout + `registerNickel` behind the
   `nickel` flag + llama-runtime blueprint (EXTERNAL mode: pings a running llama-server).
   argent still builds and runs untouched. — _validated: 69 tools flag-off / 72 flag-on._
1. **[DONE] `nickel_act` (S1) via the registry.** Grounding in `grounding/` + `describe/`,
   executing through argent's own `describe`/`gesture-tap`/`keyboard`/`gesture-swipe`
   IN-PROCESS. — _validated on live Bluesky: "tap Search" → grounded → tapped → navigated._
2. **[DONE] `nickel_look` + vision.** `look` answers visual questions off a screenshot
   (captured through argent's `screenshot` tool → `hostPath` → Gemma 4 VLM) — validated:
   it read the bottom-tab ICONS off the pixels, which the tree can't give. `nickel_do`
   now ESCALATES to vision: when a tree-grounded tap fails to resolve, it re-grounds ONCE
   with the screenshot attached (`cost.used_vision`). REMAINING: Set-of-Mark overlay
   (numbered marks) to lift grounding _precision_ further. — _senses._
3. **[DONE] `nickel_do` (S1+S2 loop) + protocol.** Autonomous observe→deliberate(S2)→
   ground(S1)→execute→re-observe loop. All four statuses exercised on live Bluesky:
   done, report(budget), blocked, need_clearance. — _worker._
4. **[DONE] Measure.** `scripts/measure.mjs` drives the tool-server and reports grounding
   latency (mean/median/p90), do success, escalation rate, vision-escalation count, and
   frontier-turns-saved. First live run (4 act probes + 3 do goals on Bluesky): grounding
   mean 2.7 s / median 3.4 s / p90 3.7 s; do success 2/3 (the miss = Search-tab label
   ambiguity → budget); 19 local steps across 3 do-calls ≈ **16 frontier turns saved**.
   Grounding on a fresh spawned server ~2–3.5 s vs 4–8 s on a degraded long-lived one. — _numbers._

### Packaging the runtime (like simulator-server)

- **Resolver** (`runtime/llama-server.ts`): `NICKEL_LLAMA_SERVER_BIN` → packaged
  `bin/<hostPlatformKey>/llama-server` → PATH. Mirrors `@argent/native-devtools-ios`.
- **Blueprint** auto-picks ATTACH (a server already answers `/health`, or `NICKEL_LLAMA_URL` is
  pinned — we don't own it) vs SPAWN (bring up + own our own; dispose kills it;
  exit→`terminated`). Validated: killed the manual server, first `nickel-act` spawned its
  own (~16 s incl. cached model load) and executed.
- **`nickel init`** (bin) warms the model cache (llama-server `-hf` fetches the ~5 GB GGUF
  once to `~/.cache/llama.cpp`); `nickel doctor` reports host/model/binary/server.
- **`scripts/download-llama-server.sh`** vendors a SELF-CONTAINED binary into `bin/`; it
  REFUSES a dynamically-linked Homebrew build (its `@loader_path/../lib` rpath breaks on a
  bare copy) and leaves the runtime on PATH. A CI-built static/bundled binary is the
  shipping TODO — the exact analogue of simulator-server's signed release.

### Design decisions locked in during Phase 3

- **S2 emits `thought` first** (chain-of-thought captured in the trace via ordered
  grammar fields) instead of relying on server-side reasoning tokens — deterministic,
  and every step's rationale lands in the returned trace.
- **Stall recovery is CYCLE detection, not no-change detection.** The weak local model
  loops; a frozen-screen check misses A↔B oscillation. We keep a ring of recent screen
  signatures — revisiting one is a stall. First we NUDGE the planner ("that didn't
  change the screen, try something else"), then escalate to `blocked` after
  `STALL_LIMIT`. The nudge alone recovered a real oscillation (tap-loop → typed "cats").
- **Risk guard is a harness floor, not model judgment.** `act/risk.ts` deterministically
  intercepts side-effecting taps (post/publish/send · buy/pay · delete · logout/unfollow)
  and forces `need_clearance` no matter what S2 decided. The model can only be MORE
  cautious than this floor. The frontier resumes by re-calling with `context: "approved: …"`.
- **`executeGrounded` (act/execute.ts) is the single action-semantics site**, shared by
  `nickel_act` and `nickel_do` — no duplication of the tap/type/swipe → argent-tool mapping.
