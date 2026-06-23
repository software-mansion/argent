# Datagen pipeline map (for the harness-agnostic refactor)

This maps the existing `datagen/` data-generation pipeline so it can be **extended**
(not rewritten) to produce a new harness-agnostic "raw trajectory" format that renders
into multiple harness formats. Everything below is read off the actual code in
`src/` and `training/`, plus a real generated record from `training/data-native/train.jsonl`.

---

## 1. End-to-end flow

```
generateTask(rng)          src/tasks.ts      -> TaskSpec       (what to do, fully resolved route)
   │
solve(task, rng, prompt)   src/expert.ts     -> SolveResult    (oracle drives the gym, records messages)
   │   └─ execute(world, tool, args)  src/gym.ts  -> ToolResult (deterministic simulated observation)
   │
assemble(sr, task, …)      src/emit.ts       -> Trajectory     ({meta, tools, messages})  ← THE CORE OBJECT
   │
validate(traj)             src/validate.ts   -> ok/errors
   │
RENDERERS (one per output format):
   ├─ toOpenAI / toShareGPT / toGemmaMessages   src/emit.ts          (used by src/generate.ts)
   └─ toNative (+ realizeObservations)          training/prepare-native.ts   ← THE RENDERER I'M GENERALIZING
                                                                              -> {messages, tools} jsonl
```

Two entry points produce datasets:

- **`src/generate.ts`** — the canonical generator. Emits normalized `train.jsonl`/`eval.jsonl`
  (full `Trajectory` objects), plus `train.openai.jsonl`, `train.sharegpt.jsonl`, `stats.json`,
  `samples.md`, `failures.jsonl`. Outputs land in `out/` (default) or `--out`.
- **`training/prepare-native.ts`** — the harness-native renderer used for the gemma4/silver
  fine-tune. Emits `train.jsonl`/`valid.jsonl` of `{messages, tools}` records into
  `training/<--out>` (default `training/data-native`). Has the `--no-narration` and
  `--realistic` switches. **This is the renderer the refactor generalizes.**

### Key intermediate data shapes (verbatim from `src/types.ts`)

```ts
export type Platform = "ios" | "android" | "chromium";

export interface Frame { x: number; y: number; w: number; h: number; }   // normalized [0,1]

export interface ElementDef {
  key: string;                 // stable per-screen key (grounding + nav edges)
  role: string;                // semantic role: button | text | heading | image | link | field | switch | tab | container | list
  component?: string;          // RN component name (debugger-component-tree)
  label?: string;
  identifier?: string;         // accessibilityIdentifier / resource-id / testID
  frame: Frame;
  navigatesTo?: string;        // tapping navigates to this screen key
  togglesState?: string;       // tapping flips this boolean key in world.toggles
  textField?: string;          // this is a text field writing to this field key
  firesRequest?: NetworkSeed;  // tapping fires this HTTP request
  isTab?: boolean;             // bottom tab-bar item
  revealedByScroll?: boolean;  // offscreen until scrolled
}

export interface ScreenDef { key: string; title: string; elements: ElementDef[]; }

export interface AppArchetype {
  id: string; name: string; platforms: Platform[];
  bundleId: string; isReactNative: boolean; metroPort?: number;
  entryScreen: string;
  screens: Record<string, ScreenDef>;
  urls?: Record<string, string>;   // deep link url -> screen key
}

// ---- Message / trajectory schema (normalized, OpenAI-ish) ----
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown>; }

export interface TrajectoryMeta {
  id: string; seed: number; task_type: string; persona: Persona; platform: Platform;
  app_archetype: string; difficulty: "easy" | "medium" | "hard"; is_react_native: boolean;
  tools_used: string[]; n_assistant_turns: number; n_tool_calls: number;
  has_recovery: boolean; source: "expert-solver";
}

export interface Trajectory {
  meta: TrajectoryMeta;
  tools: ToolSpec[];     // the tools OFFERED to the model this example (used ∪ distractors)
  messages: Message[];   // includes the system message (added by assemble())
}
```

### gym `ToolResult` (`src/gym.ts`)

`execute(world, tool, args)` returns a `ToolResult`. It mutates `world` in place and
produces the observation the real Argent tool would:

```ts
export interface ToolResult {
  content: string;        // string content for the `tool` message (usually JSON, or a formatted text block)
  autoScreenshot?: boolean;  // real tool auto-attaches a screenshot after running
  isError?: boolean;      // an injected, recoverable failure (for recovery demos)
}
```

Mechanics worth knowing for the refactor:
- `content` is **either** `JSON.stringify(obj)` (most tools) **or** a formatted **text block**
  (`describe` → `formatDescribe`, `debugger-component-tree` → `formatComponentTree`,
  `view-network-logs` → `formatNetworkLogs`, profiler reports → markdown).
- Screen-changing tools append a `screenshotNote(world)` = `"\n\n" + sceneCaption(world)` to
  `content`. `sceneCaption` returns the **idealized free screen view**:
  `[screenshot] "<Title>" screen showing: <labels…> | bottom tabs: <tabs…>`.
  This caption is what `--realistic` strips (see §3).
- `world` (the central runtime state) carries: device pool, `currentScreen`, `navStack`,
  `scrolledScreens`, `toggles`, `fieldValues`, profiler/flow/network state, `clock`, and a
  consume-once `inject: InjectionPlan` (tapMissOnce, describeFailsOnce, bootTimeoutOnce,
  debuggerDropOnce). Built fresh per trajectory by `buildWorld` in `src/world.ts`.

---

## 2. The intermediate "trajectory" object (the harness-agnostic-ish core)

The closest thing to a harness-agnostic raw trajectory **today** is the `Trajectory` object
returned by `assemble()` in `src/emit.ts`. It is the seam every renderer already consumes.

```ts
Trajectory = {
  meta: TrajectoryMeta,   // task_type, persona, platform, difficulty, tools_used, has_recovery, …
  tools: ToolSpec[],      // offered tools (catalog entries: {name, description, inputSchema})
  messages: Message[],    // ordered turns:
                          //   [0] system (ARGENT_SYSTEM_PROMPT, injected by assemble)
                          //   user  (the task phrasing from narrate.ts)
                          //   assistant { content: narration, tool_calls?: [{id,name,arguments}] }
                          //   tool   { tool_call_id, name, content }   ← raw gym observation string
                          //   … repeating …
                          //   assistant { content }  (final plain-text answer, no tool_calls)
}
```

So an ordered "step" today = an `assistant` message (narration + zero-or-more `tool_calls`)
followed by one `tool` message per call. Concretely, each step carries:

- **tool name** — `ToolCall.name`
- **args** — `ToolCall.arguments` (a JS object)
- **raw observation** — the matching `tool` message `.content` (the gym's `ToolResult.content`,
  still including the `[screenshot] …` caption at this stage)
- **thought / narration** — the `assistant` message `.content` (from `narrate.ts` banks)

**Important nuance for the refactor:** this `Trajectory` is *already partly rendered*, not truly
harness-agnostic:
1. The `system` message is baked in (`ARGENT_SYSTEM_PROMPT`) by `assemble()`.
2. Tool `content` strings are gym-format, including the idealized `[screenshot]` caption — a
   harness/observation-style decision, not a neutral fact.
3. Tool names are the **real** Argent names; remapping happens later (none today, but the
   `--realistic`/FIXED set is a name-level filter).
4. `tool_calls` have generated ids and a fixed `arguments`-as-object encoding.

A truly harness-agnostic raw trajectory would push (1)/(2) **out** of `assemble` and into the
per-harness renderer, leaving the core as: ordered steps of `{thought, calls:[{name,args}],
observations:[rawGymResult]}` + the un-rendered system policy + the selected tool catalog +
meta. See §6.

---

## 3. What `prepare-native.ts` does to render (the existing renderer)

`training/prepare-native.ts` is `main()` → `collect()` → `genRow(seed)` → `toNative(traj)`.
It re-runs the **whole** generation per row (it does not read `Trajectory` from disk):

```
genRow(seed):
  rng = new RNG(seed)
  task = generateTask(rng)                         // src/tasks.ts
  if REALISTIC && !NAV_KINDS.has(task.kind) return null   // drop profiling/flow/network kinds
  persona = pickPersona(rng, task.kind)            // src/narrate.ts
  prompt  = userTaskPhrase(rng, task.kind, …)      // src/narrate.ts
  sr      = solve(task, rng, prompt)               // src/expert.ts  -> SolveResult
  offered = REALISTIC ? FIXED_TOOLS                // fixed 8-tool set
                      : buildOfferedTools(catalog, sr.toolsUsed, rng, OFFERED_TOOLS)  // used ∪ distractors, capped at --tools (default 8)
  if REALISTIC && !sr.toolsUsed ⊆ FIXED_TOOL_NAMES return null
  traj    = assemble(sr, task, seed, offered, persona)   // src/emit.ts -> Trajectory
  if !validator.validate(traj).ok return null
  return toNative(traj)                            // -> {messages, tools}
```

`toNative(traj)` is the actual **render** to the harness-native `{messages, tools}` record:

- **Message assembly / role mapping** (per `Message`):
  - `assistant` → `{ role:"assistant", content, tool_calls? }` where each call becomes
    `{ id, type:"function", function:{ name, arguments } }` with **`arguments` left as an OBJECT**
    (the gemma4 chat template renders dicts, not JSON strings — this is the key difference from
    `toOpenAI`, which JSON-stringifies arguments).
  - `tool` → `{ role:"tool", tool_call_id, content }` (drops `name`).
  - `system`/`user` → passed through `{ role, content }`.
- **Narration stripping (`--no-narration`)**: for assistant turns **that carry tool_calls**,
  `content` is forced to `""` (so the model can't confuse mid-task narration with a
  narration-only final answer and stop early). The final answer turn (no tool_calls) keeps its
  content.
- **Tools render**: `traj.tools.map(t => ({ type:"function", function:{ name, description,
  parameters: t.inputSchema } }))`.
- **Observation rewriting (`--realistic`)**: `realizeObservations(messages)` runs last:
  1. Build `id → toolName` from assistant `tool_calls`.
  2. For every `tool` message: strip the gym's free `[screenshot] …` caption
     (`SCENE_CAPTION = /\n\n\[screenshot\][\s\S]*$/`).
  3. If the tool that produced it is in `INTERACTION_TOOLS` (the screen-changing set), append
     the **real** argent post-action marker:
     ```
     \n\n--- Screen after action ---\n\nSaved: /tmp/argent/screen-<n>.png
     ```
  This makes observations match what OpenCode + real argent return (an unreadable image + a
  path; the only readable screen-state is `describe`). The expert already calls `describe`
  before every tap, so trajectories stay coherent.

**Tool-name remapping:** there is **none** today. `--realistic` is a *filter* over real Argent
names (the `FIXED_TOOL_NAMES` allow-list of 8) + a task-kind filter (`NAV_KINDS`), not a
rename. The fixed nav/interaction set is:
`list-devices, launch-app, open-url, describe, gesture-tap, gesture-swipe, keyboard, button`
(must match `bench/opencode/argentbench.md` and `data-realistic/`).

`INTERACTION_TOOLS` (screen-changing, get the post-action marker): `launch-app, open-url,
restart-app, reinstall-app, gesture-tap, gesture-swipe, gesture-scroll, gesture-pinch,
gesture-rotate, gesture-drag, gesture-custom, keyboard, button, run-sequence, rotate`.

**On-the-wire native record** (confirmed from `training/data-native/train.jsonl`): top-level
keys are exactly `{ messages, tools }`. `messages.length` ~19 for a nav task; first assistant
tool-call turn:
```json
{ "role":"assistant", "content":"Let me list the devices…",
  "tool_calls":[{ "id":"call_1", "type":"function",
                  "function":{ "name":"list-devices", "arguments":{} } }] }
```
tool result: `{ "role":"tool", "tool_call_id":"call_1", "content":"{\"devices\":[…]}" }`.

For reference, the other renderers in `src/emit.ts`:
- `toOpenAI` — same shape but `arguments` JSON-**stringified**, `content || null`.
- `toShareGPT` — single `conversations` list; tool calls inlined as `<tool_call>{…}</tool_call>`
  text in the gpt turn; `tools` is a JSON string.
- `toGemmaMessages` — Gemma-2 has only user/model turns: folds system policy + offered tools +
  task into the first user turn (`buildGemmaFirstUser`/`gemmaSystemPreamble`), renders tool
  calls as `<tool_call>` text blocks in model turns, folds tool results into the next user turn
  as `<tool_response>…</tool_response>`, and strips the long describe coordinate header
  (`compactObservation` / `DESCRIBE_NOTE_RE`).

---

## 4. Tool names actually used + describe-observation format

**Catalog**: `spec/tools.json` has **67 entries**. Each entry shape:
```json
{ "name": "list-devices",
  "description": "List iOS simulators, Android emulators, …",
  "inputSchema": { "type": "object", "properties": { … } } }
```
Names are read as `catalog.map(t => t.name)`. `inputSchema` is a raw JSON Schema object
(rendered as `parameters` in OpenAI/native tool form).

**Tools the gym actually has a transition for** (the executable subset the expert can call;
from the `switch` in `gym.ts::execute`):
`list-devices, boot-device, launch-app, restart-app, reinstall-app, open-url, describe,
debugger-status, debugger-connect, debugger-component-tree, debugger-evaluate,
debugger-inspect-element, debugger-reload-metro, gesture-tap, gesture-swipe, gesture-scroll,
keyboard, button, run-sequence, screenshot, screenshot-diff, react-profiler-start,
native-profiler-start, react-profiler-stop, native-profiler-stop, react-profiler-analyze,
native-profiler-analyze, profiler-combined-report, react-profiler-status,
react-profiler-renders, react-profiler-cpu-summary, react-profiler-fiber-tree,
react-profiler-component-source, profiler-cpu-query, profiler-commit-query, gesture-pinch,
rotate, debugger-log-registry, native-describe-screen, chromium-tabs, gather-workspace-data,
flow-start-recording, flow-add-echo, flow-add-step, flow-finish-recording,
flow-read-prerequisite, flow-execute, view-network-logs, view-network-request-details,
native-network-logs, stop-all-simulator-servers, stop-simulator-server, stop-metro`.

**`--realistic` fixed nav set (8)**: `list-devices, launch-app, open-url, describe, gesture-tap,
gesture-swipe, keyboard, button`.

**`describe` observation string** (from `formatDescribe` in `src/format.ts`; ported from
`packages/tool-server/src/tools/describe/format-tree.ts`). Real example pulled from the
dataset (iOS native Settings):

```
Source: ax-service
Mode: flat
Coordinates are normalized [0,1] fractions of the screen (x, y, width, height), not pixels — pass them straight to gesture-tap / gesture-swipe / gesture-pinch, which expect this same space. To tap an element, use its centre: tap_x = frame.x + frame.width / 2, tap_y = frame.y + frame.height / 2.

ROOT  AXGroup (0.000, 0.000, 1.000, 1.000)

  AXHeading "Settings"  (0.060, 0.060, 0.600, 0.050)
  AXButton "Wi-Fi" id="com.apple.settings.wifi"  (0.060, 0.140, 0.880, 0.070)
  AXButton "General" id="com.apple.settings.general"  (0.060, 0.225, 0.880, 0.070)
  …
```

Format details:
- Header: `Source: <ax-service|uiautomator|cdp-dom>`, `Mode: <flat|nested>` (ios=flat,
  android/chromium=nested), the long normalized-coordinate note (`DESCRIBE_HEADER_NOTE`),
  blank, then `ROOT  <rootRole> (0.000, 0.000, 1.000, 1.000)` (rootRole: ios=`AXGroup`,
  android=`android.view.ViewGroup`, chromium=`RootWebArea`), blank.
- Body lines: `<indent><role> "<label>" id="<identifier>"<flags>  (x, y, w, h)` with frame
  to 3 decimals. `role` is mapped per platform via `ROLE_MAP`. Android adds interactivity
  flags `[clickable,…]`; iOS/Chromium don't. Elements sorted by `y` then `x`. In the gym the
  `[screenshot] …` caption is appended after this block (and stripped under `--realistic`).
- RN apps use `formatComponentTree` instead (header `Screen: <w>x<h>`, then
  `<Title>Screen`, then `  <Component> "<label>" [testID=<id>] (tap: x,y)` lines).

Use this to compare against real `argent describe` output when validating the new renderers.

---

## 5. How to run the generator and renderer

`package.json` (`"type":"module"`, scripts: `generate`, `selfcheck`). Node v24 runs the `.ts`
files directly via native type-stripping (no build step). Both entry points re-run generation
from a seed; nothing is read back from disk between solve and render.

**Canonical generator** (writes full `Trajectory` jsonl + openai/sharegpt + stats + samples):
```bash
cd datagen
npm run generate -- --n 800 --evalN 100            # or: node src/generate.ts --n 800 --evalN 100
# flags: --n, --seed, --out, --evalN, --samples, --emit openai,sharegpt
# outputs -> out/ (default) : train.jsonl eval.jsonl train.openai.jsonl train.sharegpt.jsonl stats.json samples.md failures.jsonl
npm run selfcheck                                   # node src/selfcheck.ts
```

**Harness-native renderer** (the one being generalized):
```bash
cd datagen
node training/prepare-native.ts --n 2500 --valid 150 --out data-native
# flags: --n, --valid, --out (dir name under training/), --tools N (offered tools, default 8),
#        --no-narration, --realistic
# outputs -> training/<out>/ : train.jsonl  valid.jsonl   (records are {messages, tools})
```

Output directories that already exist (evidence of prior runs): `out/`,
`training/data-native/`, `training/data-native-poc/`, `training/data-nonarr*`,
`training/data-realistic/` (the `--realistic` set, where tool observations carry
`--- Screen after action --- … Saved: /tmp/argent/screen-N.png`). There is an empty
`harness/` dir (just created) — the natural home for the new harness renderers.

---

## 6. Recommendation: the cleanest seam for harness-agnostic raw trajectories + pluggable renderers

**Reuse `solve()` + the gym + `Trajectory` as the raw trajectory; introduce a `Renderer`
interface and move the harness-specific bits out of `assemble`/`toNative` into renderers.**

The pipeline already converges on one object (`Trajectory`) consumed by five renderers
(`toOpenAI`, `toShareGPT`, `toGemmaMessages`, `toNative`, plus the markdown sampler). That
convergence point is the seam — don't invent a parallel core.

Concrete plan (minimal, additive):

1. **Define the neutral raw trajectory.** Either (a) keep `Trajectory` as-is and treat its
   `messages` + `tools` + `meta` as the raw form, or (b, cleaner) add a thin `RawTrajectory`
   that is `Trajectory` minus the two baked-in harness decisions:
   - drop the injected `system` message from `assemble()` (or make it opt-in) and instead carry
     the **policy text** (`ARGENT_SYSTEM_PROMPT` / `ARGENT_POLICY_COMPACT`) as a field, so each
     renderer decides whether it's a system turn (native/openai) or folded into the first user
     turn (gemma).
   - keep tool `content` as the **raw gym observation** (with the `[screenshot]` caption intact);
     make caption-stripping / `--- Screen after action ---` rewriting a renderer concern, not a
     `prepare-native`-only concern.

   Practically: have `solve()`/`assemble()` return `{ meta, policy, tools, messages }` where
   `messages` has no system turn and tool contents are raw. This is a small change — `assemble`
   currently just prepends one system message.

2. **Add a `Renderer` interface** (new `harness/` dir):
   ```ts
   interface HarnessRenderer {
     name: string;                                   // "native" | "openai" | "sharegpt" | "gemma" | …
     render(raw: RawTrajectory, opts: RenderOpts): unknown;   // -> one jsonl record
   }
   ```
   Port the existing functions into renderers verbatim: `toOpenAI`, `toShareGPT`,
   `toGemmaMessages` become `OpenAIRenderer`, `ShareGPTRenderer`, `GemmaRenderer`. `toNative`
   becomes `NativeRenderer`.

3. **Factor the observation transforms into reusable, renderer-selectable steps**, since they
   are the real harness variance:
   - `stripSceneCaption` (the `SCENE_CAPTION` regex) — used by realistic + gemma.
   - `appendScreenAfterAction` (the `INTERACTION_TOOLS` → `--- Screen after action ---` marker)
     — realistic only.
   - `stripDescribeHeader` (`DESCRIBE_NOTE_RE` / `compactObservation`) — gemma only.
   - `stripNarrationOnToolCalls` (`--no-narration`) — option, any renderer.
   These already exist as one-off functions; lift them to a shared `observation-transforms.ts`
   and let each renderer compose the ones it needs via `RenderOpts`. `realizeObservations`
   becomes `compose(stripSceneCaption, appendScreenAfterAction)`.

4. **Tool-name remapping hook (future-proofing).** There is no remapping today, but the FIXED
   set / NAV_KINDS filtering is a renderer-level policy. Put `toolFilter?: (used) => boolean`
   and an optional `toolNameMap?: Record<string,string>` in `RenderOpts` so a future harness
   that uses different tool names (or a different fixed surface) is a config change, not a code
   fork. Apply the map uniformly to `tools[].name`, `tool_calls[].name`, and the
   `tool_call_id → name` lookup inside the observation transforms.

5. **One driver, many outputs.** Replace the two near-duplicate generation loops
   (`generate.ts` and `prepare-native.ts` both do generateTask→solve→validate) with a single
   `generateRaw(seed) -> RawTrajectory|null` and then fan out: `for (renderer of selected)
   write(renderer.render(raw, opts))`. `prepare-native.ts` becomes `--harness native`;
   `--realistic`/`--no-narration` become `RenderOpts`. This kills the duplication and makes
   "add a harness" = "add a renderer + register it," nothing else.

**What to reuse unchanged:** the gym (`gym.ts`), expert (`expert.ts`), tasks/archetypes/graph,
`format.ts` serializers, `validate.ts`, and the catalog (`spec/tools.json`). The refactor is
entirely in the assemble→render seam (`emit.ts` + `prepare-native.ts`), which is exactly where
the harness-specific logic already lives.
