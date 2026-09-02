# Argent iOS runner wire protocol (v1)

One HTTP POST per command. The request body is a JSON object; the reply is a
JSON **envelope**. Connections close after each exchange (`Connection:
close`). The server listens on loopback on the port given by the
`ARGENT_RUNNER_PORT` environment variable (forwarded by xcodebuild from
`TEST_RUNNER_ARGENT_RUNNER_PORT` on the launching process; absent or `0`, the
system assigns a port, which is how a session run straight from Xcode comes
up), reachable through usbmux (USB cable only); the forwarded stream
terminates on the device's loopback, so a loopback bind covers the whole
transport.

The envelope is authoritative; the HTTP status is informational (200 for ok
envelopes, 500 for error envelopes). Two rejections come from the framing
layer, before command dispatch, still shaped as `INVALID_REQUEST` envelopes:
400 when a finished header block lacks a usable Content-Length, and 413 when
the declared or received body exceeds 2 MB (`maxRequestBytes`,
RunnerHTTPServer.swift).

There is no version handshake: the tool-server's artifact cache key includes
the runner sources, so a protocol change always ships with a rebuilt runner.

## Envelope

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "…", "message": "…", "hint": "…" } }
```

`hint` is optional, phrased for the agent operating the device.

A success envelope for an app-scoped command may additionally carry a
top-level `reactivated: true`: the target app was alive but backgrounded, and
the runner re-fronted it before executing: the foreground screen changed as
a side effect of the command. The field is encoded only when true, so a
command against an already-foreground target stays byte-identical on the
wire.

A success envelope for a mutating command may additionally carry a top-level
`warning: "…"`: the command succeeded, but the suppressed-issue counter (the
suppression-wording contract under `status`) grew while it executed, so muted
accessibility noise may be hiding a gesture that missed; the warning tells
the agent to re-observe the screen and confirm the effect. Suppressed noise
never flips `ok` (those shapes accompany healthy mutations; that is why the
suppression exists). Read-only commands never carry the field, it composes
with `reactivated` (one reply can carry both), and it is encoded only when
set, so clean replies stay byte-identical on the wire.

## Request fields

| Field                 | Used by             | Meaning                                                                 |
| --------------------- | ------------------- | ----------------------------------------------------------------------- |
| `command`             | all                 | Command name (below).                                                   |
| `commandId`           | all but `status`    | Client-stamped id for send-once tracking.                               |
| `statusCommandId`     | `status`            | Journal lookup key.                                                     |
| `appBundleId`         | app-scoped commands | Target app. Required, never inferred.                                   |
| `x`, `y`              | `tap`, `longPress`  | Absolute points in the app's space.                                     |
| `numberOfTaps`        | `tap`               | Taps in the one gesture (default 1; 2 = native double-tap).             |
| `fromX/fromY/toX/toY` | `drag`              | Absolute start/end points.                                              |
| `durationMs`          | `longPress`, `drag` | Press duration / movement duration.                                     |
| `holdMs`              | `drag`              | Rest at the start point before moving (default 50 ms).                  |
| `settle`              | `drag`              | Rest at the destination before lifting (~0 release velocity, no fling). |
| `text`                | `type`              | Text for the focused input.                                             |
| `button`              | `button`            | `home`, `volumeUp`, `volumeDown` or `actionButton`.                     |

## Commands

App-scoped (require `appBundleId`; a live but backgrounded target is re-fronted
first and the reply stamped `reactivated: true`, except for `snapshot`, which
is observation only: it never re-fronts and fails with `APP_BACKGROUNDED`
naming the bundle id, so reading the screen cannot change what is on it. A
target that reports `.notRunning`, and one whose state is unreadable, which is
what hardware reports for an app killed outside this session, fail with
`APP_NOT_AVAILABLE` on every command. Activating either would be a full
launch, and launching is launch-app's job, never a command side effect):

- `viewport` → `{x, y, width, height}`: `XCUIApplication.frame` (full app,
  keyboard included). Same rect describe normalizes against, so 0-1 tap
  coordinates invert that mapping.
- `tap`, `longPress`, `drag` → `{message}`: coordinate gestures via
  XCUICoordinate (public API; orientation-safe). `tap` executes
  `numberOfTaps` taps as one on-device gesture: 2 maps to the native
  `doubleTap()`, >2 to a tight tap loop (no native N-tap API; inter-tap
  latency stays on-device, inside the OS multi-tap window). `drag` presses
  for `holdMs` at the start, moves at the velocity `durationMs` implies, and
  rests `settle`-long before lifting; a long-press pickup of a draggable item
  needs a `holdMs` of about 500 ms or more, since a short press never lifts
  it however slowly the finger then moves.
- `type` → `{message}`: types into the current first responder. The runner
  probes keyboard focus first and answers `TEXT_INPUT_NOT_FOCUSED` when
  nothing has it. The probe is what makes that code real on hardware: there,
  typing without a first responder RECORDS an XCTest failure instead of
  throwing, so without the probe the reply demotes to the generic
  `XCTEST_RECORDED_FAILURE`. Only a probe that positively finds no focus
  refuses; a probe that itself fails does not block typing.
- `keyboardReturn` → `{message}`: taps the visible submit key when a keyboard
  is up; otherwise it types the return character behind the same focus probe,
  so it answers `TEXT_INPUT_NOT_FOCUSED` the same way.
- `keyboardDelete` → `{message}`: types the delete character behind the same
  focus probe, so it answers `TEXT_INPUT_NOT_FOCUSED` the same way. There is
  no labeled key to prefer, and one command deletes one character.
- `snapshot` → `{nodes, quality}`: one-shot accessibility tree (below).
  `APP_BACKGROUNDED` when the target is alive but backgrounded: observation
  never re-fronts (see above).

Device-scoped:

- `status`, without `statusCommandId`: `{uptimeMs, state, suppressedIssues,
recordedFailures}`. `state` is `idle | busy | wedged`. `suppressedIssues`
  counts the XCTest issues muted as accessibility noise since launch;
  `recordedFailures` is XCTest's cumulative recorded-failure count, the
  counter that, past suppression, converts successful mutations into
  `XCTEST_RECORDED_FAILURE`. Suppression substring-matches Apple-owned
  issue wording, pinned here as part of the contract. Muted: a
  `Failed to get matching snapshot` description that also contains
  `kAXError` or `No matches found for`; kept recorded: `Timed out while
evaluating UI query`. If an Xcode release rewords those strings,
  suppression misses silently: `suppressedIssues` stops moving while
  `recordedFailures` climbs on healthy mutations. Watch the pair for that
  drift. The same counter, bracketed around each command, is what stamps the
  envelope-level `warning` (see Envelope) when it grows across an
  otherwise-ok mutation. With `statusCommandId`: the journaled fate of that
  command:
  `{commandId, state: notAccepted|accepted|started|completed|failed,
command?, responseOk?, responseJson?, errorCode?, errorMessage?,
errorHint?}`. `responseJson` is the completed command's full envelope,
  retained only when the command retains responses (`snapshot`/`screenshot`
  replies never are: large, read-only, cheaper to replay) AND the encoded
  envelope is at most 16 KB (`maxRetainedResponseBytes`,
  CommandJournal.swift). Past either gate the journal still records the fate
  and error fields, so recovery can find a command `completed` with no
  `responseJson`: the effect happened, but the response was too large to
  retain. The journal keeps the 64 most recently touched ids (`maxEntries`);
  an id evicted by newer traffic answers `notAccepted` even though the
  command ran, which the recovery rule below reads as "surface the transport
  error". `status` is answered on the transport queue, outside the serial
  execution queue, so health checks and recovery work exactly when a command
  is stuck.
- `button` → `{message}`: presses the hardware button named by the `button`
  field (`XCUIDevice.press(_:)`). `hasHardwareButton` is checked first, so a
  button this device does not have (a non-Pro iPhone has no Action button)
  fails with `UNSUPPORTED_OPERATION` instead of no-opping into a reply the
  agent reads as a press. The power/lock button and the app switcher are not on
  the wire: XCUIDevice exposes no public API for either. `volumeUp` and
  `volumeDown` are marked unavailable on the SIMULATOR SDK only, which costs
  nothing here: the runner is built for `generic/platform=iOS`.
- `screenshot` → `{imageBase64}`: full-screen PNG, always inline.
- `shutdown` → acknowledges, then ends the session cleanly after the reply
  is flushed.

## Snapshot nodes

Flat list in emission order; `parentIndex` links reconstruct the tree.

```json
{
  "index": 0,
  "type": "Button",
  "label": "General",
  "identifier": "com.apple.settings.general",
  "value": null,
  "rect": { "x": 16, "y": 768.7, "width": 361, "height": 52 },
  "enabled": true,
  "focused": null,
  "selected": null,
  "depth": 3,
  "parentIndex": 44
}
```

- `type`: XCUIElement type name (`Button`, `StaticText`, `Cell`, …).
- `rect`: viewport points. Non-finite coordinates encode as `0` on the wire
  (`finite` in `ArgentRunnerSession+Snapshot.swift`): a geometry-less AX
  element reports `CGRect.null` and must degrade to a zeroed rect, never fail
  the reply. The dedup key's integer conversion clamps overflowing values for
  the same reason (`keyCoordinate`): every conversion in the walk is total by
  contract, because a trap here killed the whole runner mid-snapshot.
- Included nodes: interactive types, scroll containers, and anything with a
  label/identifier/value; visible in the viewport; deduped by
  type+texts+geometry. Hard cap 1500 nodes (`quality.state` becomes
  `degraded`, `reasonCode: "node_cap"`). Depth is also capped: the raw walk
  stops at depth 100 and emission at depth 60; unlike the node cap,
  depth-dropped content does not mark the snapshot `degraded`.
- `quality`: `{state: healthy|degraded, backend: "xctest", reason?,
reasonCode?}`.

## Error codes

`INVALID_REQUEST`, `APP_BUNDLE_ID_REQUIRED`, `APP_NOT_AVAILABLE`,
`APP_BACKGROUNDED` (`snapshot` only: the target is alive but backgrounded, and
observation never re-fronts it), `TEXT_INPUT_NOT_FOCUSED`,
`UNSUPPORTED_OPERATION`, `RUNNER_BUSY` (the one
retryable code), `RUNNER_WEDGED` (recycle the session),
`XCTEST_RECORDED_FAILURE` (a mutation ran but XCTest recorded a real failure
during it), `SNAPSHOT_FAILED`, `COMMAND_TIMED_OUT`, `COMMAND_FAILED`.

## Timeout budgets

Every command runs under a runner-side main-thread watchdog budget
(`CommandKind.executionTimeout`, RunnerProtocol.swift); the client sends it
under a larger transport window (default `RUNNER_COMMAND_TIMEOUT_MS`,
runner-client.ts; overrides in runner-commands.ts: `GESTURE_TIMEOUT_MS` and
the `type`/`snapshot` call sites).

| Command class              | Runner budget | Client window |
| -------------------------- | ------------- | ------------- |
| `type`                     | 55s           | 60s           |
| `tap`, `longPress`, `drag` | 75s           | 90s           |
| `snapshot`                 | 30s           | 45s           |
| everything else (default)  | 30s           | 45s           |

The invariant: every client window MUST strictly exceed the matching runner
budget, so the client outlasts the runner's verdict. A command that blows
its budget is abandoned on-device and answered with `COMMAND_TIMED_OUT`; the
commands that follow answer `RUNNER_BUSY` while the abandoned work drains,
then `RUNNER_WEDGED` once it has been stuck past 120s (`wedgeThreshold`,
MainThreadGate.swift), the signal to recycle the session. A client
window at or below the budget would swallow that verdict as a raw transport
timeout and force journal recovery for an answer the runner was already
delivering. The client window is one whole-transport deadline per send
attempt: the usbmux handshake and the HTTP exchange spend from the same
budget, so a slow handshake shrinks the HTTP stage's share rather than
granting each stage the full window.

## Send-once contract

Every non-`status` command carries a client-stamped `commandId`. Duplicate
sends of an id still executing attach to the in-flight execution and share
its reply. After a lost reply, the client MUST NOT resend a mutating
command; it asks `status` + `statusCommandId` and acts on the journaled
state: `completed` → use `responseJson` (or accept result loss), `failed` →
surface the journaled error, anything else → surface the transport error.
