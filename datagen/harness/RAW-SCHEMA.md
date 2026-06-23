# RawTrajectory JSON — what a real-capture navigator agent emits

You drive a **real running app** through the Argent tool-server (HTTP) and record what you
actually did. Output is a JSON array of `RawTrajectory` objects (one per task you solved), written
to a file. These are rendered into 4 harness training formats later — so use **canonical Argent
tool names** (the renderer remaps them per harness; do NOT pre-namespace).

## Driving the device
Helper: `datagen/tools/argent-call.sh` (reads `~/.argent/tool-server.json`). Examples:
```
TS=datagen/tools/argent-call.sh
$TS schema describe                 # see exact arg names for a tool
$TS call describe   '{"udid":"<UDID>"}'
$TS call gesture-tap '{"udid":"<UDID>","x":0.5,"y":0.42}'
$TS call gesture-swipe '{"udid":"<UDID>","fromX":0.5,"fromY":0.8,"toX":0.5,"toY":0.2}'
```
- Coordinates are normalized [0,1]. To tap an element from `describe`, use its frame centre:
  `x = frame.x + frame.w/2`, `y = frame.y + frame.h/2`. **Never guess coordinates** — always
  `describe` first; re-`describe` after any screen change.
- If `describe` is too thin (custom-drawn UI, icon-only controls): fall back to `screenshot`
  (visual) and, for React Native apps only, `debugger-component-tree`.

## Canonical tool names (use these verbatim in `call.name`)
`list-devices, launch-app, open-url, describe, gesture-tap, gesture-swipe, gesture-scroll,
gesture-pinch, gesture-rotate, gesture-drag, keyboard, button, screenshot, debugger-component-tree`

## The JSON shape (one object per solved task)
```json
{
  "meta": {
    "id": "real-<app>-<n>",
    "app": "<app dir name>",
    "platform": "ios",
    "task_kind": "navigate-tap | toggle | scroll-find | swipe | pinch | search | back",
    "source": "real",
    "difficulty": "easy | medium | hard",
    "bundleId": "<bundle id>",
    "device": "<UDID>",
    "gestures": ["tap","swipe"]
  },
  "task": "Open the Settings screen and turn on dark mode.",
  "tools": [ /* the offered tool specs — leave [] and the importer fills the fixed set */ ],
  "steps": [
    {
      "call": { "name": "describe", "arguments": { "udid": "<UDID>" } },
      "observation": { "text": "<the REAL describe output you got back, verbatim>" }
    },
    {
      "call": { "name": "gesture-tap", "arguments": { "udid": "<UDID>", "x": 0.5, "y": 0.42 } },
      "observation": { "text": "", "hasScreenshot": true }
    }
  ],
  "finalAnswer": "Dark mode is now on."
}
```
Rules:
- `observation.text` = the **real** text the tool returned (paste the describe tree verbatim;
  truncate to the relevant elements if enormous, keeping the header + the elements you used).
- For screen-changing tools (tap/swipe/scroll/launch/keyboard/button) set
  `"hasScreenshot": true` and leave `text` empty (the real tool returns only an image + a path;
  the readable screen state comes from your next `describe`). The renderer injects each
  harness's screenshot junk.
- `tools` may be `[]` — the importer fills the standard offered set. If you want distractors,
  list canonical names.
- Record the **optimal** path: after solving, drop dead-ends/backtracks so the step list is the
  clean minimal route (describe → act → describe → act → … → final answer). The verifier replays
  exactly this list.

## Anti-cheating (hard rule)
Do **not** read the app's source code (lib/*.dart, *.swift views, src/screens, etc.). You may
only learn the app by **using it through Argent**. The trajectories must contain nothing you
couldn't get by navigating the running app blind.

## Task variety
Across an app's tasks, exercise a realistic mix: simple tap-navigation, toggles, scroll-to-find,
swipe (carousels/dismiss/tabs), pinch (maps/images) and back-navigation **where the app supports
them**. Don't force a gesture an app doesn't have.
