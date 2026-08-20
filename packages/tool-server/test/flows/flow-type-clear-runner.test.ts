import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";

import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// Every refusal test here pays TYPE_FOCUS_SETTLE_MS (500) plus the whole
// TYPE_FOCUS_TIMEOUT_MS (3000) on real timers, and measured in isolation on an
// idle machine they cluster at 3757-3760ms — 75% of vitest's 5000ms default,
// leaving ~1.2s of headroom on the one file whose names ("refuses to clear …")
// would make a load-induced timeout read as a real destructive-clear
// regression. This repo already has a documented parallel-load flake class;
// these tests are built to join it, and the headroom costs nothing.
vi.setConfig({ testTimeout: 20_000 });

const ANDROID_DEVICE = "emulator-5554";
/** Mirrors `flow-actions`'s own constant — the budget the early exit dodges. */
const TYPE_FOCUS_TIMEOUT_MS = 3000;
/** Mirrors `flow-actions` again: the tap→poll gap the focus window opens after. */
const TYPE_FOCUS_SETTLE_MS = 500;
let tmpDir: string;

interface Call {
  id: string;
  args: Record<string, unknown>;
}

/**
 * Android hierarchy with one EditText holding `text` and reporting focus,
 * shaped like a real device: the hint arrives as `content-desc` (the node's
 * LABEL) and the entered contents as `text` (its VALUE).
 *
 * The focus matters, and so does WHERE it sits: `runType` dispatches a
 * destructive clear only when a focus-flagged node is INSIDE the target's frame
 * — here they are the same node — or when the tree flags focus nowhere at all
 * (`noFocusXml`). Focus reported elsewhere (`unfocusedXml`) or on a node that
 * merely covers the target (`enclosingFocusXml`) refuses.
 */
const fieldXml = (text: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="${text}" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The mis-target: the tap never moves focus, so the `email` field the step aims
 * at is NOT focused and a second field elsewhere on screen holds focus instead.
 * Keys injected here reach `other`, not `email` — the shape behind a selector
 * that resolves to a label or a wrapper, and behind any app whose control
 * refuses focus on tap.
 */
const unfocusedXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="" package="com.acme.app" bounds="[40,200][1040,280]" />
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Display name" text="do not erase me" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

/**
 * A tree that reports focus on NO node at all — the shape an iOS build whose
 * injected framework predates the `firstResponder` field produces, where
 * `getFullHierarchy` simply omits it. Distinct from `unfocusedXml`: there the
 * tree can see focus and says it is elsewhere; here it cannot see focus at all,
 * which is no evidence against the clear. Verified on an iPhone 16 Pro, where
 * conflating the two refused every clear on the platform.
 */
const noFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The shape an overlap test cannot tell from a real confirmation: the only
 * focus-flagged node CONTAINS the target rather than sitting inside it.
 *
 * Measured on a live Chromium page as a screen-spanning shadow host (whose
 * `document.activeElement` is the host, never the inner element) with an input
 * of its own holding the keys, and again as a `focusin` focus trap on an
 * ordinary `<textarea>`. In both, a clear aimed at `email` emptied the ENCLOSING
 * element and left `email` untouched while the step reported a pass.
 */
const enclosingFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" resource-id="host" content-desc="Editor" text="do not erase me" focused="true" package="com.acme.app" bounds="[0,100][1080,1900]" />
    <node index="1" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * The overlay: a focused input sitting INSIDE the named field's box without
 * being it — a mention/autocomplete popover over a composer. What separates it
 * from `wrapperFocusXml` below is where the TAP lands: the overlay sits clear
 * of the named element's centre, so the gesture went to the named element and
 * the focus is somebody else's.
 */
/**
 * Two ANONYMOUS fields in one row — no resource-id on either, so `sameElement`
 * falls through to the label. Every other fixture in this file identifies its
 * nodes, so nothing here reached that fallback, and it is the whole defect it
 * pins: two elements sharing a name are not one element. `second` decides
 * whether the name collides. On Android the collision needs no coincidence —
 * `identifier` is the raw resource-id, which names the layout SLOT, so every
 * row inflated from one layout carries the same one.
 *
 * Built so the ambiguity is the ONLY thing deciding the outcome: the row's
 * centre (540) falls in the FOCUSED field, which is also first in tree order,
 * so with a distinct sibling name the step confirms through the under-the-tap
 * arm. Make the names collide and nothing else about the screen changes. (An
 * earlier shape put focus on the field the tap MISSED, which every later gate
 * refuses on its own, so both arms were refused and the ambiguity test itself
 * was never exercised.)
 */
const anonymousRowXml = (second: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="amount-row" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" content-desc="Amount" clickable="true" focused="true" package="com.acme.app" bounds="[280,200][1040,280]" />
      <node index="1" class="android.widget.EditText" content-desc="${second}" clickable="true" package="com.acme.app" bounds="[40,200][240,280]" />
    </node>
  </node>
</hierarchy>`;

/**
 * A row whose two children are separated by a GAP, so the container's centre
 * (540) covers neither of them — a flex `gap`, `space-between`, a margin, or a
 * divider the adapter does not emit. `secondControl` decides whether the row
 * holds one control or two; focus sits on the LEFT child either way, and the
 * tap point lands on nothing but the row itself.
 *
 * With two controls the tap cannot say which one it meant, and the clear went
 * to whichever already held focus — reproduced on Chrome 151, where the left
 * input was emptied and rewritten with a pass reported on the row. With one it
 * is the tall-label shape: the container's single control took the focus the
 * gesture asked for.
 */
const gapRowXml = (secondControl: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="name-row" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" resource-id="first" content-desc="First name" text="do not erase me" clickable="true" focused="true" package="com.acme.app" bounds="[40,200][500,280]" />
      <node index="1" class="${secondControl ? "android.widget.EditText" : "android.widget.TextView"}" resource-id="last" content-desc="Last name" text="Smith" ${secondControl ? 'clickable="true" ' : ""}package="com.acme.app" bounds="[580,200][1040,280]" />
    </node>
  </node>
</hierarchy>`;

/**
 * Two rows answering to ONE id, and a re-layout between the tap and the focus
 * poll — keyboard avoidance, the everyday movement `trackTarget` exists to
 * follow. `scrolled` moves the SECOND row to where the first was tapped, so it
 * becomes the nearest namesake and a proximity tie-break adopts it as "the
 * target". The identity arm then trusts it absolutely.
 */
const twoSameIdRowsXml = (scrolled: boolean, focusedFirst = false) =>
  scrolled && focusedFirst
    ? // The same scrolled screen with the namesakes listed the other way round.
      // First-match-wins is not a rule about safety: where the focused
      // namesake happens to come first, falling back to "the first one" hands
      // the clear the element the selector never resolved to — so the refusal
      // has to come from the ambiguity itself, not from the fixture's order.
      `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="row" content-desc="Row" text="SECRET-B" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    <node index="1" class="android.widget.EditText" resource-id="row" content-desc="Row" text="KEEP-ME" package="com.acme.app" bounds="[40,20][1040,100]" />
  </node>
</hierarchy>`
    : `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="row" content-desc="Row" text="KEEP-ME" package="com.acme.app" bounds="${scrolled ? "[40,20][1040,100]" : "[40,200][1040,280]"}" />
    <node index="1" class="android.widget.EditText" resource-id="row" content-desc="Row" text="SECRET-B" ${scrolled ? 'focused="true" ' : ""}package="com.acme.app" bounds="${scrolled ? "[40,200][1040,280]" : "[40,400][1040,480]"}" />
  </node>
</hierarchy>`;

/**
 * A focus trap whose own text EQUALS the target's. Both nodes carry the string
 * as their own accessible name, and the trap's box contains the field — so
 * text equality plus containment, which is the whole of the editing-host test,
 * is satisfied by an element that is not one. An anonymous target makes the
 * equality structural rather than lucky: its text hoists into every enclosing
 * node. What separates the two is that an editing host has no text of its OWN.
 */
const trapWithMatchingTextXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="notes" content-desc="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,100][1040,500]" />
    <node index="1" class="android.widget.EditText" resource-id="email" content-desc="old.remembered.login" package="com.acme.app" bounds="[80,200][900,280]" />
  </node>
</hierarchy>`;

/**
 * The wrapper whose centre misses its own input: a label tall enough to hold
 * the container's centre point, with the field below it. A container is not
 * laid out to put its input at its centre, so this is a layout coin toss rather
 * than a corner — a two-line label, a label with padding, or a label plus
 * helper text all reach it, and the React Native `Pressable`-wrapping-a-
 * `TextInput` shape needs no label at all (hence the clickable wrapper here).
 *
 * `labelTakesTaps` makes the thing under the tap point a CONTROL, which is the
 * whole difference from the row above: there the tap really did reach something
 * that takes focus.
 */
const tallLabelWrapperXml = (labelTakesTaps: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="field" clickable="true" package="com.acme.app" bounds="[40,200][1040,400]">
      <node index="0" class="android.widget.TextView" content-desc="Email address" ${labelTakesTaps ? 'clickable="true" ' : ""}package="com.acme.app" bounds="[40,200][1040,340]" />
      <node index="1" class="android.widget.EditText" resource-id="inner" clickable="true" content-desc="Email" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,340][1040,400]" />
    </node>
  </node>
</hierarchy>`;

/**
 * `overlayFocusXml`'s wrapper twin. The overlay fixture alone cannot exercise
 * the focus poll at all for a wrapper selector: with no `email-wrapper` node in
 * it, every overlay read is consumed by selector resolution before the tap is
 * even dispatched, and the first read the focus poll sees already confirms.
 * This one carries the wrapper, so a `clear` really does have to poll PAST an
 * overlapping read.
 */
const overlayOverWrapperXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,300]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
    <node index="1" class="android.widget.EditText" resource-id="suggestions" content-desc="Suggestions" text="do not erase me" focused="true" package="com.acme.app" bounds="[80,260][900,380]" />
  </node>
</hierarchy>`;

const overlayFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,600]" />
    <node index="1" class="android.widget.EditText" resource-id="suggestions" content-desc="Suggestions" text="do not erase me" focused="true" package="com.acme.app" bounds="[80,300][900,380]" />
  </node>
</hierarchy>`;

/**
 * The legitimate non-identity case the containment test has to keep working:
 * the selector names a testID wrapper and focus is reported by the input INSIDE
 * it. A second focused node sits elsewhere on screen, so the verdict cannot
 * come from "something, somewhere, is focused".
 */
const wrapperFocusXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,300]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Display name" text="do not erase me" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

/**
 * The everyday label-above-input shape: a `{ text: Email }` selector matches the
 * LABEL as a substring and the field exactly, so the two halves of a `type` step
 * must resolve it the same way. The ranked resolver picks the field for both;
 * an unranked reading-order pick took the label for the focus check while the
 * tap went to the field, and the identity test could then never match — a
 * `clear` hard-failed pointing at a selector that already resolves correctly.
 */
const labelAboveFieldXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.TextView" text="Email address" package="com.acme.app" bounds="[40,100][540,140]" />
    <node index="1" class="android.widget.EditText" resource-id="email" content-desc="Email" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,300][1040,380]" />
  </node>
</hierarchy>`;

/**
 * The same enclosing shape as `enclosingFocusXml`, but only just: the focused
 * WebView clears the target by `pad` px on every side. The containment
 * epsilon's slack is per-EDGE, so a symmetric pad well under it made an
 * ENCLOSING node satisfy "sits inside the target" and take the clear — a pass
 * on a field the step never touched. Comparing extents is what refuses it, and
 * comparing them EXACTLY is what refuses it at every pad: a trap one pixel
 * larger on each edge destroyed a draft on Chrome 151, and it is the same
 * geometry as `overhangingChildXml`, so no tolerance can separate the two.
 */
const enclosingByPadXml = (pad: number) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.webkit.WebView" resource-id="host" content-desc="Editor" text="do not erase me" focused="true" package="com.acme.app" bounds="[${40 - pad},${200 - pad}][${1040 + pad},${280 + pad}]" />
    <node index="1" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,200][1040,280]" />
  </node>
</hierarchy>`;

/**
 * A row wrapper over TWO inputs, with focus on the one the tap does NOT land
 * on. Containment alone accepts it — `currency` is inside `amount-row` — and
 * the step then clears and rewrites a field the report never names. The tap
 * goes to the row's centre (540px), which is inside `amount`.
 */
const twoInputRowXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="amount-row" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" resource-id="currency" content-desc="Currency" text="USD" focused="true" package="com.acme.app" bounds="[40,200][240,280]" />
      <node index="1" class="android.widget.EditText" resource-id="amount" content-desc="Amount" text="0.00" package="com.acme.app" bounds="[280,200][1040,280]" />
    </node>
  </node>
</hierarchy>`;

/**
 * `twoInputRowXml`'s other half — the row split EVENLY, so its centre is the
 * seam between the two children.
 *
 * The uneven fixture only ever exercises the discriminating side of the
 * tap-point test. An inclusive containment test admits BOTH halves at a seam
 * and so discriminates nothing: the clear then empties whichever half holds
 * focus and reports a pass on the row. The OS routes a tap at the seam to the
 * RIGHT child (left/top inclusive, right/bottom exclusive, in `Rect.contains`,
 * `CGRectContainsPoint` and `elementFromPoint` alike), so `focusOn: "left"` is
 * the destructive case and `focusOn: "right"` is the honest one. Even splits
 * are the common case: six OTP boxes on a 1080px screen land on exact 180px
 * boundaries. Reproduced on Chrome 42 and on Android API 36.
 */
const evenSplitRowXml = (focusOn: "left" | "right") =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="name-row" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" resource-id="first" content-desc="First name" text="do not erase me" ${focusOn === "left" ? 'focused="true" ' : ""}package="com.acme.app" bounds="[40,200][540,280]" />
      <node index="1" class="android.widget.EditText" resource-id="last" content-desc="Last name" text="Smith" ${focusOn === "right" ? 'focused="true" ' : ""}package="com.acme.app" bounds="[540,200][1040,280]" />
    </node>
  </node>
</hierarchy>`;

/**
 * The other end of `enclosingByPadXml`, and — once the ancestry is flattened
 * away — the same geometry: the focused input inside the wrapper OVERHANGS it
 * by `pad` px on every side, the way a focus ring or a border rounds out of an
 * integer bounds pair. A tolerance admitting it admits a focus trap laid over
 * the field by the same margin, so `pad: 0` (the input filling its wrapper, the
 * everyday shape) is the admitting case and every overhang refuses.
 */
const overhangingChildXml = (pad: number) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Email" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[${40 - pad},${200 - pad}][${1040 + pad},${280 + pad}]" />
    </node>
  </node>
</hierarchy>`;

/**
 * An overlay that covers the tap point ITSELF, rather than sitting clear of it
 * like `overlayFocusXml`. Geometry cannot tell "the tap hit the overlay" from
 * "the overlay appeared BECAUSE of the tap" — only whether it was there when
 * the gesture was dispatched can, which is what `present` varies.
 */
const centreOverlayXml = (present: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" package="com.acme.app" bounds="[40,200][1040,600]" />
    ${present ? '<node index="1" class="android.widget.EditText" resource-id="mention" content-desc="Mention" text="do not erase me" focused="true" package="com.acme.app" bounds="[240,350][840,450]" />' : ""}
  </node>
</hierarchy>`;

/**
 * `wrapperFocusXml` with the wrapper GROWN downwards, as an autocomplete does
 * when it renders its listbox inside itself on focus. Only the box changes; the
 * input stays where the tap hit it.
 */
const grownWrapperXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,900]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
      <node index="1" class="android.widget.TextView" text="Suggestion one" package="com.acme.app" bounds="[40,300][1040,400]" />
    </node>
  </node>
</hierarchy>`;

/**
 * A typeahead list that opens on focus, one of whose suggestions repeats the
 * field's own value. `{ text: "Paris" }` matches the field exactly before the
 * tap and matches BOTH afterwards — and the chip is smaller, so a re-run of the
 * selector hands it the match.
 */
const typeaheadXml = (withSuggestion: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.widget.EditText" resource-id="q" content-desc="City" text="Paris" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    ${withSuggestion ? '<node index="1" class="android.widget.TextView" text="Paris" package="com.acme.app" bounds="[40,320][300,380]" />' : ""}
  </node>
</hierarchy>`;

/**
 * A rich-text composer: the editable node carries the focus and no name of its
 * own, and the only text belongs to the block child inside it — what Quill,
 * ProseMirror and Lexical all render. Every selector that can name the content
 * therefore resolves to a DESCENDANT of the focused node. With `extraLine` the
 * editor shows more than the selector named, which is the negative control.
 */
const richTextEditorXml = (extraLine: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" focused="true" package="com.acme.app" bounds="[40,200][1040,400]">
      <node index="0" class="android.widget.TextView" text="Draft body here" package="com.acme.app" bounds="[45,210][1035,250]" />
      ${extraLine ? '<node index="1" class="android.widget.TextView" text="and a second paragraph" package="com.acme.app" bounds="[45,260][1035,300]" />' : ""}
    </node>
  </node>
</hierarchy>`;

/**
 * A focused, non-editable WRAPPER around exactly one anonymous FIELD. At the
 * tree level it is the editing host `richTextEditorXml` describes, node for
 * node: the field's contents are its accessible name, an anonymous node does
 * not shield, so the name hoists and the wrapper carries the target's text with
 * none of its own. What tells them apart is what the wrapper wraps — an editing
 * host's content is static text, never another control. Hosted payment fields
 * (one input per iframe) and a `<div tabindex=0>` focus trap are both this
 * shape; the trap was confirmed on Chrome 151, where only the keyboard tool's
 * own "not a text field" refusal stopped the clear.
 */
const wrapperAroundOneFieldXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" focused="true" package="com.acme.app" bounds="[40,100][1040,500]">
      <node index="0" class="android.widget.EditText" content-desc="hello-target" clickable="true" package="com.acme.app" bounds="[80,200][900,280]" />
    </node>
  </node>
</hierarchy>`;

/**
 * The role test's over-match: Material's `TextInputLayout` is the non-editable
 * WRAPPER that carries the app's `resource-id`, and `deriveUiAutomatorRole`
 * matches `textinput` on the short class name, so it derives `TextField`.
 * Identical to `wrapperFocusXml` apart from that class.
 */
const textInputLayoutWrapperXml = () =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="com.google.android.material.textfield.TextInputLayout" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,300]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Username or email address" text="old.remembered.login" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Display name" text="do not erase me" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

function mockRegistry(
  calls: Call[],
  getHierarchy: () => { xml: string } | Promise<{ xml: string }>,
  /**
   * What the `keyboard` tool answers. Only the clear-carrying call is worth
   * varying: it is the one that can succeed in a weaker way than asked and say
   * so in a `note`.
   */
  keyboardResult?: (args: Record<string, unknown>) => unknown
): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
      calls.push({ id, args });
      if (id === "list-devices") return { devices: [] };
      if (id === "keyboard" && keyboardResult) return keyboardResult(args);
      return { ok: true };
    }),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      getHierarchy: vi.fn(async () => getHierarchy()),
      getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
    })),
  } as unknown as Registry;
}

async function writeFlow(name: string, flow: Parameters<typeof serializeFlow>[0]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), serializeFlow(flow), "utf8");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

/** Keyboard call args with the auto-injected `udid` stripped, in call order. */
const keyboardArgs = (calls: Call[]) =>
  calls
    .filter((c) => c.id === "keyboard")
    .map(({ args }) => {
      const { udid: _udid, ...rest } = args;
      return rest;
    });

const run = (registry: Registry) =>
  createRunFlowTool(registry).execute(
    {},
    { name: "f", project_root: tmpDir, device: ANDROID_DEVICE }
  );

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-type-clear-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("type directive — clear dispatch", () => {
  it("clears and types in ONE keyboard call, then submits (tap → clear+text → enter)", async () => {
    const calls: Call[] = [];
    // The field a `clear` exists for: one that already holds a value.
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("old.remembered.login") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);

    // Clear and text MUST ride one call. Every backend validates the whole
    // request before touching the device, so a rejected `text` leaves the field
    // untouched; split across two calls the clear commits first and a rejection
    // then leaves the field empty — worse off than before a call that failed.
    // Enter stays separate: `typeTv` rejects `key` outright before typing, so
    // folding it in would leave a TV target's field empty on submit.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true, text: "new@example.com" }, { key: "enter" }]);

    // …and the focusing tap comes before all of them.
    const order = calls
      .filter((c) => c.id === "gesture-tap" || c.id === "keyboard")
      .map((c) => c.id);
    expect(order[0]).toBe("gesture-tap");
  });

  it("carries the keyboard's `note` into the step report instead of dropping it", async () => {
    // The step still PASSES — the clear was carried out — but on Android it may
    // have been carried out by a path nothing can verify, and the note is the
    // only thing that says which. A QA flow's value is knowing what its green
    // bought, so dropping it here is the one place it matters most.
    const calls: Call[] = [];
    const NOTE = "keyboard clear: the atomic accessibility replace was not used (…).";
    const registry = mockRegistry(
      calls,
      () => ({ xml: fieldXml("old.remembered.login") }),
      (args) =>
        args.clear === true ? { typed: "x", keys: 1, cleared: true, note: NOTE } : { ok: true }
    );

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(result.steps[0]!.warning).toBe(NOTE);
  });

  it("leaves the step warning-free when the clear reported none", async () => {
    // The counterpart: a verified clear says nothing, and a step report that
    // warned anyway would train the reader to ignore the field.
    const calls: Call[] = [];
    const registry = mockRegistry(
      calls,
      () => ({ xml: fieldXml("old.remembered.login") }),
      () => ({
        typed: "x",
        keys: 1,
        cleared: true,
      })
    );

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps[0]!.status).toBe("pass");
    expect(result.steps[0]!.warning).toBeUndefined();
  });

  it("carries the note of a clear recorded as a RAW tool step too", async () => {
    // `flow-add-step` has no `keyboard` → `type` rewrite, so a recorded clear
    // replays as a raw tool step. Its report used to carry the note inside
    // `result` and no warning at all — and `argent-cli`'s own `StepReport` has no
    // `result` field, so the CLI printed a clean pass over an unverified clear.
    const calls: Call[] = [];
    const NOTE = "keyboard clear: the atomic accessibility replace was not used (…).";
    const registry = mockRegistry(
      calls,
      () => ({ xml: fieldXml("old.remembered.login") }),
      (args) =>
        args.clear === true ? { typed: "x", keys: 1, cleared: true, note: NOTE } : { ok: true }
    );

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "keyboard", args: { clear: true, text: "new@example.com" } }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(result.steps[0]!.warning).toBe(NOTE);
  });

  it("leaves a raw tool step warning-free when its result carries no note", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(
      calls,
      () => ({ xml: fieldXml("old.remembered.login") }),
      () => ({ typed: "x", keys: 1, cleared: true })
    );

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "keyboard", args: { clear: true, text: "new@example.com" } }],
    });

    const result = asRun(await run(registry));
    expect(result.steps[0]!.status).toBe("pass");
    expect(result.steps[0]!.warning).toBeUndefined();
  });

  it("refuses to clear when the focus wait never sees focus reach the target", async () => {
    // The destructive case: the tap did not move focus, so a clear would empty
    // whichever field still holds it — silently, and reported as a pass on a
    // field it never touched. Reproduced on a Pixel 3a before this guard.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: unfocusedXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    // Nothing may reach the device — not the clear, not the text, not Enter.
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses to clear when the only focus flag merely COVERS the target", async () => {
    // An overlap test confirms this by construction, and every shape that
    // produces it — an open shadow root, a focused WebView, a focus trap — can
    // hide a different element holding the keys. Driven on a live Chromium
    // page, the clear emptied the enclosing element and reported a pass.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: enclosingFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("CONTAINS");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses to clear when a focused OVERLAY sits over the named field", async () => {
    // The mirror of the enclosing case, and the one geometry alone cannot tell
    // from the legitimate wrapper below: a suggestion popover's input sits
    // INSIDE the composer's box without being it. Driven on a live Chromium
    // page, the clear emptied the popover, left the composer untouched, and
    // reported a pass on the composer.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: overlayFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("OVERLAPS");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears when focus lands on the input inside the wrapper the selector named", async () => {
    // Containment, not identity: the legitimate case the strict test must keep
    // working. The decoy focused node elsewhere on screen is what stops this
    // passing on "something, somewhere, reports focus".
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: wrapperFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it.each([1, 2, 3, 4, 5, 12, 100])(
    "refuses to clear when the only focused node encloses the target by %ipx",
    async (pad) => {
      // The containment epsilon must not admit an ENCLOSING node. Its slack is
      // per-edge, so a symmetric pad of half the tolerance satisfied it on every
      // side at once: at 4px the WebView took the clear and the step passed.
      //
      // The sweep starts at ONE pixel because that is where the defect lived
      // after the extent comparison arrived: a trap 1-2px larger on every edge
      // still cleared, and destroyed a draft on Chrome 151. Starting at 4 left
      // exactly that range unswept.
      const calls: Call[] = [];
      const registry = mockRegistry(calls, () => ({ xml: enclosingByPadXml(pad) }));

      await writeFlow("f", {
        executionPrerequisite: "",
        steps: [
          {
            kind: "type",
            into: { identifier: "email-wrapper" },
            text: "new@example.com",
            clear: true,
          },
        ],
      });

      const result = asRun(await run(registry));
      expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
      expect(result.steps[0]!.reason).toContain("refusing to clear");
      expect(keyboardArgs(calls)).toEqual([]);
    }
  );

  it("refuses to clear a container whose focused input is not the one the tap hit", async () => {
    // Containment on its own has no discriminator: `currency` is inside
    // `amount-row` just as much as the input inside a testID wrapper is. The
    // tap lands at the row's centre, which is inside `amount`, so the focus
    // belongs to a sibling and the keys would empty a field the report names
    // nowhere. Reproduced on Chrome 151 before this test existed: the step
    // passed and `#currency` came back holding the replacement.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: twoInputRowXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "amount-row" }, text: "12.50", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears through a wrapper whose role reads as a text input", async () => {
    // The role test this replaced called Material's `TextInputLayout` a text
    // field (its short class name contains "textinput"), skipped the
    // containment arm, and failed a legitimate wrapper clear while blaming an
    // overlay that was not on screen. ARIA 1.1's `combobox`-on-the-wrapper does
    // the same on Chromium. Geometry answers both without a role vocabulary.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: textInputLayoutWrapperXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("resolves the focus check against the same node the tap targeted", async () => {
    // One ranked resolver behind both halves of the step. `{ text: Email }`
    // matches the label above the field as a substring and the field itself
    // exactly, so an unranked pick takes the label — the tap still lands on the
    // field (it goes through the ranked resolver), and the identity check then
    // compares the focused field against the label and can never match.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: labelAboveFieldXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Email" }, text: "new@example.com", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    // The tap centre is the FIELD's, not the label's: 340/1920 down the screen.
    const tap = calls.find((c) => c.id === "gesture-tap");
    expect(tap!.args.y).toBeCloseTo(340 / 1920, 5);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("refuses to clear when every read in the focus window failed", async () => {
    // A tree-source outage is not the same as a tree that reported nothing:
    // nothing was observed, so nothing is known about what holds focus.
    // `settleTree` draws the same line for the same condition.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The pre-tap settle succeeds (so `waitForFrame` resolves), then every
      // read inside the focus window throws.
      if (reads > 2) throw new Error("device disconnected");
      return { xml: fieldXml("old.remembered.login") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).toContain("stopped answering");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses to clear when the reads go dark after seeing nothing focused", async () => {
    // `lastRead` is only written by a read that SUCCEEDED, so a single
    // successful poll used to disarm the outage verdict for the whole window —
    // including the FIRST poll, which is the one most likely to report "no
    // focus yet" because the app's focus round-trip has not finished. That
    // verdict maps to "unobservable", which a destructive clear goes through
    // on, so a tree-source outage in the tail turned a refusal into a blind
    // clear. Reproduced on Chrome 151 by poisoning the tree read at t+600ms
    // with focus landing elsewhere at t+900: the step passed and emptied a
    // field it never named.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The pre-tap settle reads and the first focus poll succeed and see
      // nothing focused; every read after that throws.
      if (reads > 3) throw new Error("device disconnected");
      return { xml: noFocusXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("stopped answering");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses to clear when the read that ends the window HANGS rather than throwing", async () => {
    // A counter of consecutive FAILED polls can only be reached by failures
    // that come back fast, and that is not how a tree source goes down: every
    // transport's own timeout outlasts this whole window — 15s for the Android
    // `getHierarchy`, 10s per CDP call, 5s per ViewInspector RPC — so one hang
    // ends the window with the counter at one. Reproduced on Chrome 151 with a
    // page blocking its own main thread for 12s from the focusing tap's
    // mousedown: the step PASSED, emptied a field it never named, and ran 13.9s
    // while its report claimed a 3000ms window.
    const calls: Call[] = [];
    let reads = 0;
    let hungReadSettled = false;
    const registry = mockRegistry(calls, () => {
      reads++;
      // Two pre-tap settle reads and one clean focus poll, then a read that
      // does not come back inside the window.
      if (reads <= 3) return { xml: noFocusXml() };
      return new Promise<{ xml: string }>((_resolve, reject) => {
        const timer = setTimeout(() => {
          hungReadSettled = true;
          reject(new Error("device wedged"));
        }, 15_000);
        // Nothing may wait on this: the point is that the step does not.
        (timer as unknown as { unref?: () => void }).unref?.();
      });
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const startedAt = Date.now();
    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("stopped answering");
    expect(keyboardArgs(calls)).toEqual([]);
    // And the wait was bounded by the window rather than by the transport: the
    // step answered while the hung read was still outstanding, which is what
    // keeps every refusal message's "within 3000ms" true.
    expect(hungReadSettled).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  });

  it("absorbs a single failed poll rather than calling it an outage", async () => {
    // One failure is the last-poll blip the tolerance exists for. Only the read
    // AFTER the deadline check fails here, so the window still ends on a
    // determinate observation and keeps its own verdict.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      if (reads === 5) throw new Error("transient blip");
      return { xml: unfocusedXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("focus never reached");
    expect(result.steps[0]!.reason).not.toContain("stopped answering");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("does not let a read that sees NO focus erase one that saw where focus is", async () => {
    // An empty focus set is not the observation "nothing is focused" — it is
    // equally "this read could not see the element that is", which is what both
    // flow adapters produce for a frame that has clipped to zero area (the
    // everyday keyboard-avoidance scroll). Letting it overwrite a determinate
    // sighting drops the verdict to "unobservable", the one non-confirmed
    // outcome a destructive clear goes through on, so the field the run had
    // already identified as holding the keys is the one emptied. Reproduced on
    // Chrome 151: collapsing the focused input's box mid-window took the step
    // from a refusal to a pass that emptied and rewrote it, while it kept the
    // caret and was still `document.activeElement` at the end.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The pre-tap settle reads plus the first focus poll see the OTHER field
      // focused; every read after that sees no focus anywhere.
      return { xml: reads <= 3 ? unfocusedXml() : noFocusXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("focus never reached");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("judges focus by the latest read that saw it, not by any read that ever did", async () => {
    // Latest-read-wins still decides BETWEEN sightings. With a sticky "saw focus
    // at any point" flag the verdict depended on whether round 1 beat the app's
    // focus round-trip, so the same flow against the same app gave a different
    // reason between runs. Here the first sighting puts the flag on a node
    // CONTAINING the target and the later ones put it on a different field, and
    // the refusal has to be the later one's.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: reads <= 3 ? enclosingFocusXml() : unfocusedXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("focus never reached");
    expect(result.steps[0]!.reason).not.toContain("CONTAINS");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears when the tree reports focus on no node at all", async () => {
    // The refusal keys off focus being reported SOMEWHERE ELSE, not off the poll
    // failing. A tree that never flags focus is not evidence the tap missed —
    // treating it as such disabled `clear` on every iOS build whose injected
    // framework omits `firstResponder`.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: noFocusXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("compares focus against where the target is NOW, not where it was tapped", async () => {
    // Keyboard avoidance scrolls the field away from the point the tap landed
    // on. The identity arm does not care, but the geometric one — the selector
    // named a wrapper and the input inside it reports focus — compares boxes,
    // and against the stale tap frame the input is no longer inside it. Every
    // other fixture here is static, so this is otherwise never exercised.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // From the focus poll onwards the whole group sits 500px higher.
      const y = reads <= 2 ? 900 : 400;
      return {
        xml:
          `<?xml version='1.0' encoding='UTF-8'?><hierarchy rotation="0">` +
          `<node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]">` +
          `<node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" ` +
          `bounds="[40,${y - 20}][1040,${y + 100}]">` +
          `<node index="0" class="android.widget.EditText" resource-id="email" ` +
          `content-desc="Username or email address" text="old.remembered.login" ` +
          `focused="true" bounds="[40,${y}][1040,${y + 80}]" />` +
          `</node></node></hierarchy>`,
      };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("still types on an unconfirmed focus when there is no clear", async () => {
    // The refusal is scoped to the destructive half. Misplaced text is additive
    // and visible, and "no focus seen" can also mean the focused view never made
    // it into the tree — so a plain type stays best-effort, as it always was.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: unfocusedXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "new@example.com" }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ text: "new@example.com" }, { key: "enter" }]);
  });

  it("does not poll to the timeout for a verdict a plain type never reads", async () => {
    // Only a `clear` acts on the outcome, so only a `clear` keeps polling once
    // something focused has been seen covering the target. The shape is the
    // ordinary hybrid one: uiautomator flags the enclosing WebView, not the
    // EditText inside it, and an enclosing node cannot confirm — so without the
    // early exit a WebView-hosted form of n fields pays n × TYPE_FOCUS_TIMEOUT_MS
    // on the path with no clear at all.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: enclosingFocusXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "new@example.com" }],
    });

    const result = asRun(await run(registry));

    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    // Reads 1-2 are the pre-tap settle; read 3 is the focus wait's first and
    // only look. A poll to the deadline would take ~10 more, so the count IS
    // the early exit — exactly, and at any machine speed.
    //
    // Deliberately not a wall-clock bound as well. `elapsed < 3000` measured
    // the whole step — temp dir, device resolution, the 500ms settle, two
    // keyboard dispatches — so it read the machine rather than the exit, and
    // failed at 3066ms and 3388ms on a loaded host with the count still at 3.
    expect(reads).toBe(3);
    expect(keyboardArgs(calls)).toEqual([{ text: "new@example.com" }, { key: "enter" }]);
  });

  it("does not submit a clear-only step", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("stale draft") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    // Enter into a field the step just emptied is never the intent — and on a
    // search box it would run an empty query.
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }]);
  });

  it("submits a clear-only step when the author asks for it explicitly", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("stale query") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, clear: true, submit: true }],
    });

    asRun(await run(registry));
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ clear: true }, { key: "enter" }]);
  });

  it("issues no clear call for a plain type step", async () => {
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x" }],
    });

    asRun(await run(registry));
    const keyboard = keyboardArgs(calls);
    expect(keyboard).toEqual([{ text: "x" }, { key: "enter" }]);
  });

  it("reads the tree no more than a plain type step does", async () => {
    // The clear must not add a read-back pass. An earlier cut verified the
    // field was empty afterwards; that check was blind on iOS and on Chromium
    // `<input>` (neither carries a `value`) and actively failed correct
    // behaviour on Android fields whose hint becomes the value once emptied.
    // Pin the absence so it is not reintroduced by reflex.
    let reads = 0;
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: fieldXml("") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x" }],
    });
    asRun(await run(registry));
    const withoutClear = reads;

    reads = 0;
    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "email" }, text: "x", clear: true }],
    });
    asRun(await run(registry));

    expect(reads).toBe(withoutClear);
  });
});

describe("type directive — clear at a container's seam", () => {
  it("refuses when an EVENLY split row's focused half is not the one the tap hit", async () => {
    // The uneven `twoInputRowXml` only exercises the discriminating side of the
    // tap-point test. At a seam an inclusive containment test admits both
    // halves and decides nothing, so the clear went to whichever half held
    // focus and the step reported a pass on the row. Reproduced on Chrome 42
    // and Android API 36 before the half-open test.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: evenSplitRowXml("left") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "name-row" }, text: "Jones", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears the EVENLY split row's half the tap did hit", async () => {
    // The control that keeps the fix from being a blanket refusal: the same
    // fixture with focus on the right of the seam, which is where the OS routes
    // a tap landing exactly on it.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: evenSplitRowXml("right") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "name-row" }, text: "Jones", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "Jones" }, { key: "enter" }]);
  });

  it("still clears when the focused input fills its wrapper exactly", async () => {
    // The admitting side of containment, and the everyday shape: a testID
    // wrapper whose input spans it. Equal frames are no bigger, so the size
    // test passes them while refusing every overhang below.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: overhangingChildXml(0) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it.each([1, 2, 3])(
    "refuses to clear when the focused node overhangs its wrapper by %ipx",
    async (pad) => {
      // The other half of the enclosing-pad sweep, and the same geometry: a
      // node overhanging on every side is a node ENCLOSING the target, whether
      // the tree calls it the wrapper's input or a focus trap laid over it.
      // Any tolerance that admits this admits a 1px trap over the field, which
      // destroyed a draft on Chrome 151 — so the size test is exact and this
      // side refuses from one pixel up.
      const calls: Call[] = [];
      const registry = mockRegistry(calls, () => ({ xml: overhangingChildXml(pad) }));

      await writeFlow("f", {
        executionPrerequisite: "",
        steps: [
          {
            kind: "type",
            into: { identifier: "email-wrapper" },
            text: "new@example.com",
            clear: true,
          },
        ],
      });

      const result = asRun(await run(registry));
      expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
      expect(result.steps[0]!.reason).toContain("refusing to clear");
      expect(keyboardArgs(calls)).toEqual([]);
    }
  );
});

describe("type directive — the tree moving between the tap and the focus poll", () => {
  it("still clears when the named container GROWS after the tap", async () => {
    // Every other fixture holds the tree constant across polls, which is the
    // blind spot that let this through: recomputing the tap point from the
    // target's current frame follows a container that grows, and an
    // autocomplete wrapper rendering its listbox inside itself on focus drops
    // the recomputed centre out of the input and into the option list. The
    // clear was then refused blaming an overlay that is not on the page.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // Settling needs two identical reads, so the growth lands only once the
      // tap has been dispatched against the small wrapper.
      return { xml: reads <= 2 ? wrapperFocusXml() : grownWrapperXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("refuses when an overlay appears over the tap point AFTER the tap", async () => {
    // An overlay covering the tap point used to confirm on the argument that
    // the tap must have hit it. That holds only for one already on screen when
    // the gesture went out. An @-mention list, an inline picker or a formatting
    // bar rendered in RESPONSE to the tap was hit by nothing, and taking focus
    // was enough to make it swallow the clear while the composer kept its draft
    // and the step passed on the composer. Reproduced on Chrome 42.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: centreOverlayXml(reads > 2) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears through an overlay that was ALREADY over the tap point", async () => {
    // The control, and the case the old rationale was right about: the tap
    // really did land on the overlay, so focus reaching its field is the honest
    // consequence of the gesture. Only the timing separates it from the run
    // above.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: centreOverlayXml(true) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("still clears when the selector re-resolves to a BETTER-ranked node after the tap", async () => {
    // `tappedFrame` only covered a round where the selector fails to resolve at
    // all. A typeahead suggestion repeating the field's own value resolves
    // instead of it — an exact text match on a smaller frame — so the focus
    // check tested an element the step never touched and refused, reporting
    // that focus never reached the target while focus was exactly where the
    // flow had put it.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: typeaheadXml(reads > 2) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Paris" }, text: "Berlin", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "Berlin" }, { key: "enter" }]);
  });

  it("keeps polling past an intermediate overlap read instead of refusing on it", async () => {
    // `requireEvidence` has a well-covered perf half — a plain `type` exits on
    // the first overlapping read — and an unpinned safety half. A `clear` must
    // NOT take that exit: the overlay here is gone by the third read and the
    // real focus is inside the wrapper, so refusing on the intermediate verdict
    // would fail a step that is about to be confirmable.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: reads <= 3 ? overlayOverWrapperXml() : wrapperFocusXml() };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "type",
          into: { identifier: "email-wrapper" },
          text: "new@example.com",
          clear: true,
        },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });
});

describe("type directive — what a refusal is allowed to say", () => {
  it.each([
    ["focus reported elsewhere", unfocusedXml, "email"],
    ["a focused node enclosing the target", enclosingFocusXml, "email"],
    ["a focused overlay over the target", overlayFocusXml, "email"],
  ])("keeps the focused element's own text out of the reason (%s)", async (_name, xml, into) => {
    // The reason is written to the run report on disk and echoed to the agent,
    // and a focused node's label can BE the field's value — a password
    // manager's suggestion, a recovery phrase, the draft the step refused to
    // destroy. Every fixture here carries that text on the focused node, so a
    // reason that quoted it would fail this.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: xml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: into }, text: "x", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(result.steps[0]!.reason).not.toContain("do not erase me");
  });
});

describe("type directive — a rich-text composer", () => {
  it("clears an editor whose only text sits in a child node", async () => {
    // Quill / ProseMirror / Lexical render the content in a block child, and
    // the editable node itself carries no id, no name and no own text — so
    // every selector that can name the content resolves to a descendant of the
    // focused node. That read as "encloses" and was refused with advice (point
    // the selector at the input itself) that nothing on the page can satisfy.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: richTextEditorXml(false) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Draft body here" }, text: "REPLACED", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "REPLACED" }, { key: "enter" }]);
  });

  it("refuses when the enclosing focused node shows more than the selector named", async () => {
    // The control that keeps the editor arm off the shapes "encloses" exists
    // for: a focused WebView wrapping a form, or a focus trap on a textarea,
    // both show text of their own beyond the target's, exactly like this second
    // paragraph the step never named.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: richTextEditorXml(true) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Draft body here" }, text: "REPLACED", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses a focused WRAPPER whose only text belongs to one field inside it", async () => {
    // The editor's twin, and the shape the editing-host gate admitted: a
    // focused non-editable wrapper around ONE anonymous field carries the
    // target's text with none of its own, exactly like a contenteditable
    // carrying its paragraph's. What separates them is that an editing host's
    // content is static text — a control inside means the thing holding focus
    // is a wrapper, and the keys would be dispatched at it. Confirmed on Chrome
    // 151, where the gate passed and only the keyboard tool's "the focused
    // element DIV#wrap is not a text field" stopped the clear; iOS and Android
    // dispatch at whatever holds focus and have no such backstop.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: wrapperAroundOneFieldXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "hello-target" }, text: "REPLACED", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });
});

describe("type directive — a name is not an identity", () => {
  it("refuses to clear a row of ANONYMOUS fields whose names COLLIDE", async () => {
    // `sameElement` compares role + identifier and falls back to the LABEL when
    // neither side has an identifier — the everyday React Native and plain-DOM
    // shape, and the one no other fixture in this file reaches. Two elements
    // sharing a name are not one element, so "the focused node is A namesake of
    // something under the tap" handed the clear to whichever namesake held
    // focus. Reproduced on Chrome 151: the LEFT field was emptied and rewritten
    // with a pass reported on the row.
    //
    // Everything else on this screen confirms — the focused field IS the one
    // under the tap point — so the colliding name is the only thing this and
    // its twin below differ on. With focus on a field the tap MISSED, later
    // gates refuse both arms and the ambiguity test is never reached.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: anonymousRowXml("Amount") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "amount-row" }, text: "9", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears the ANONYMOUS field under the tap when its sibling is named differently", async () => {
    // The twin: one name, one element, and the tap landed on it. It is also
    // what keeps the label fallback honest in the other direction — matching
    // every anonymous node of a role against every other would make this row
    // ambiguous too, and refuse a clear that is exactly on target.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: anonymousRowXml("Currency") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "amount-row" }, text: "9", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "9" }, { key: "enter" }]);
  });

  it("refuses to clear when a re-layout puts a different namesake where the tap landed", async () => {
    // `trackTarget` follows the element the step tapped rather than re-running
    // the selector, but "the same element" is a name test, and it fell through
    // to "nearest to where the tap landed" when several nodes answered. Any
    // re-layout between the tap and the poll — keyboard avoidance is the
    // everyday one — can put a different namesake nearest, and the identity arm
    // then trusts it absolutely, bypassing the under-the-tap gate entirely.
    // Reproduced on Chrome 151: the row the selector never resolved to was the
    // one emptied, and the step passed.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The selector resolves and the tap goes out against the unscrolled
      // layout; the focus poll sees the scrolled one.
      return { xml: twoSameIdRowsXml(reads > 2) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "row" }, text: "TYPED", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses the same re-layout when the FOCUSED namesake is the first one listed", async () => {
    // The other tree order, and the one that shows the refusal comes from the
    // ambiguity rather than from the fixture: handing back "the first
    // namesake" instead of nothing gives the identity arm the focused row
    // here, which confirms absolutely and empties the row the selector never
    // resolved to. Reading order is not a safety property.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: twoSameIdRowsXml(reads > 2, true) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "row" }, text: "TYPED", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses an enclosing focused node that shows the target's text as its OWN", async () => {
    // Text equality plus containment is the whole editing-host test, and a
    // focus trap satisfies both the moment its draft equals the field's value —
    // structurally, not by luck, since an anonymous target's text hoists into
    // every enclosing node. Reproduced on Chrome 151: the step passed, the
    // TEXTAREA was emptied and rewritten, and the named input kept its old
    // value. An editing host is the one that has no text of its own.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: trapWithMatchingTextXml() }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });
});

describe("type directive — a tap the container's own chrome absorbed", () => {
  it("clears when nothing under the tap point could have taken the keys", async () => {
    // One probe point — the container's centre — and a container is not laid
    // out to put its input there. Measured on Chrome 151 by sweeping only the
    // label's height on one page: 16/24/32px cleared, 40/48/60px refused, while
    // the tap focused the right field either way and the same step without
    // `clear` succeeded. The refusal then blamed an overlay and a sibling row
    // that did not exist.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: tallLabelWrapperXml(false) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "field" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("still refuses when the thing under the tap point is itself a control", async () => {
    // The negative half. A control under the point means the tap DID reach
    // something that takes focus, so focus sitting elsewhere is the mis-target
    // the gate exists for — the row case, spelled with one field and one
    // tappable label rather than two fields.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: tallLabelWrapperXml(true) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "field" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses when the tap point is inert but the container holds TWO controls", async () => {
    // `underTap` holds what COVERS the tap point, so a gap between two children
    // empties it and "nothing under the tap is a control" becomes vacuously
    // true — the clear then went to whichever sibling already held focus, four
    // OTP boxes away from the tap on Chrome 151. The evidence the arm needs is
    // that the container has exactly ONE control to route focus to.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: gapRowXml(true) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "name-row" }, text: "Jones", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears through the same gap when the container holds ONE control", async () => {
    // The twin, with the second child a plain label rather than a field: the
    // tap point covers nothing either way, so the gap is not what decides —
    // the number of controls that could have taken the keys is.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: gapRowXml(false) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "name-row" }, text: "Jones", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "Jones" }, { key: "enter" }]);
  });
});

describe("type directive — report rendering", () => {
  it("names the clear in the run report's step target", async () => {
    // `into X` alone reads as a plain append, so a replace-a-field step would
    // be indistinguishable in the report from the bug it fixes.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: fieldXml("") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "x", clear: true },
        { kind: "type", into: { identifier: "email" }, text: "y" },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps[0]!.target).toContain("clear first");
    expect(result.steps[1]!.target).not.toContain("clear first");
  });
});

/**
 * A rich-text composer holding the named paragraph BESIDE content the selector
 * never named. `sibling` decides how that content reaches the tree: an
 * identified node — or a password field — SHIELDS its own text out of every
 * ancestor's `subtreeText` (`flow-tree-flatten`), so the editor's hoist is
 * indistinguishable from one holding the paragraph alone, while a clear on it
 * (select-all over the host) destroys everything inside.
 */
const composerWithSiblingXml = (sibling: "identified" | "password" | "anonymous" | "none") =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" focused="true" package="com.acme.app" bounds="[40,200][1040,500]">
      <node index="0" class="android.widget.TextView" text="Draft body here" package="com.acme.app" bounds="[45,210][1035,250]" />
      ${
        sibling === "identified"
          ? '<node index="1" class="android.widget.TextView" resource-id="signature" text="Wire funds to IBAN PL61" package="com.acme.app" bounds="[45,300][1035,340]" />'
          : sibling === "password"
            ? '<node index="1" class="android.widget.EditText" password="true" text="hunter2" package="com.acme.app" bounds="[45,300][1035,340]" />'
            : sibling === "anonymous"
              ? '<node index="1" class="android.widget.TextView" text="Wire funds to IBAN PL61" package="com.acme.app" bounds="[45,300][1035,340]" />'
              : ""
      }
    </node>
  </node>
</hierarchy>`;

/**
 * The element the tap landed on stops being findable — it unmounted as a
 * consequence of the tap (a tap-to-edit row, a conditional render, a
 * virtualized list) — while a DIFFERENT element answering the same selector
 * holds focus. `mounted` is the control.
 */
const unmountingRowXml = (mounted: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    ${
      mounted
        ? '<node index="0" class="android.widget.EditText" resource-id="a" content-desc="Email" text="target-value" focused="true" package="com.acme.app" bounds="[40,200][1040,280]" />'
        : ""
    }
    <node index="1" class="android.widget.EditText" resource-id="other" content-desc="Email address" text="DRAFT-DO-NOT-ERASE" ${mounted ? "" : 'focused="true" '}package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

/**
 * A testID wrapper over one field, where a SECOND field answering to the same
 * resource-id appears inside the wrapper on focus and takes it. `present`
 * decides whether the namesake is there yet.
 *
 * On Android the collision needs no coincidence: `identifier` is the raw
 * resource-id, which names the layout slot, so every row inflated from one
 * layout carries the same one.
 */
const lateNamesakeXml = (present: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,${present ? "460" : "300"}]">
      <node index="0" class="android.widget.EditText" resource-id="row_input" content-desc="Row" text="old.remembered.login" clickable="true" package="com.acme.app" bounds="[40,200][1040,280]" />
      ${
        present
          ? '<node index="1" class="android.widget.EditText" resource-id="row_input" content-desc="Row" text="KEEP-ME" clickable="true" focused="true" package="com.acme.app" bounds="[40,340][1040,420]" />'
          : ""
      }
    </node>
  </node>
</hierarchy>`;

/**
 * A namesake that is OUTSIDE the target's box and no larger than it — the shape
 * only the containment half of the gate refuses.
 *
 * The other two conjuncts pass it: it is 1000x80 against the wrapper's 1000x120,
 * so `frameNoLargerThan` holds, and its name resolves to exactly one candidate
 * inside the tap (the inner field), so both namesake counts hold too. Without
 * `frameWithin` the clear would be confirmed from a field two hundred pixels
 * below the container the step named, and emptied there.
 */
const outsideNamesakeXml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="email-wrapper" package="com.acme.app" bounds="[40,180][1040,300]">
      <node index="0" class="android.widget.EditText" resource-id="email" content-desc="Email" text="old.remembered.login" clickable="true" package="com.acme.app" bounds="[40,200][1040,280]" />
    </node>
    <node index="1" class="android.widget.EditText" resource-id="email" content-desc="Email" text="KEEP-ME" clickable="true" focused="true" package="com.acme.app" bounds="[40,600][1040,680]" />
  </node>
</hierarchy>`;

/**
 * A 44px row that GROWS on focus — the validation or helper line the gate's own
 * comments cite — swallowing a field that sat below it and was never a tap
 * candidate. `sameName` decides whether that field shares the decoy's
 * accessible name, which is the only channel the two halves of the gate are
 * joined by.
 */
const growingRowXml = (grown: boolean, sameName: boolean) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="row" package="com.acme.app" bounds="[40,200][1040,${grown ? "480" : "288"}]">
      <node index="0" class="android.widget.EditText" content-desc="Email" text="decoy@corp.example" clickable="true" package="com.acme.app" bounds="[40,204][1040,284]" />
      <node index="1" class="android.widget.EditText" content-desc="${sameName ? "Email" : "Nickname"}" text="old@corp.example" clickable="true" ${grown ? 'focused="true" ' : ""}package="com.acme.app" bounds="[40,320][1040,400]" />
    </node>
  </node>
</hierarchy>`;

/**
 * An amount row split unevenly, so its centre falls on the DECOY. The victim
 * reformats its value on focus — a currency input dropping its separators, a
 * phone or card mask — renaming itself OUT of the namesake set and leaving the
 * decoy as the unique pre-tap match. The victim holds focus in both post-tap
 * stages, so the rename is the only difference between them:
 *
 *   - "pre-tap"  — before the gesture: nothing focused, the two names distinct;
 *   - "renamed"  — focused and reformatted (the defect);
 *   - "kept"     — focused with its own name intact (the control).
 *
 * Anonymous fields, so `sameElement` falls through to the label, and the label
 * of a field with no content-desc IS its value.
 */
const reformattingRowXml = (stage: "pre-tap" | "renamed" | "kept") =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,1920]">
    <node index="0" class="android.view.ViewGroup" resource-id="row" package="com.acme.app" bounds="[40,200][1040,280]">
      <node index="0" class="android.widget.EditText" content-desc="${stage === "renamed" ? "1234.5" : "1,234.50"}" clickable="true" ${stage === "pre-tap" ? "" : 'focused="true" '}package="com.acme.app" bounds="[40,200][390,280]" />
      <node index="1" class="android.widget.EditText" content-desc="1234.5" clickable="true" package="com.acme.app" bounds="[400,200][1040,280]" />
    </node>
  </node>
</hierarchy>`;

describe("type directive — the clear gate's two-tree joins", () => {
  it("refuses to clear an editing host that also holds IDENTIFIED content", async () => {
    // The shield is what makes it possible: an identified descendant keeps its
    // text out of every ancestor's hoist, so an editor holding the named
    // paragraph PLUS a signature block compares equal to one holding the
    // paragraph alone — and the clear is a select-all over the whole host.
    // Reproduced on Chrome 151 against this branch: the step passed, the editor
    // was rewritten and the signature went with it.
    for (const sibling of ["identified", "password"] as const) {
      const calls: Call[] = [];
      const registry = mockRegistry(calls, () => ({ xml: composerWithSiblingXml(sibling) }));

      await writeFlow("f", {
        executionPrerequisite: "",
        steps: [
          { kind: "type", into: { text: "Draft body here" }, text: "REWRITTEN", clear: true },
        ],
      });

      const result = asRun(await run(registry));
      expect(
        result.steps.map((s) => s.status),
        sibling
      ).toEqual(["fail"]);
      expect(result.steps[0]!.reason).toContain("refusing to clear");
      expect(keyboardArgs(calls)).toEqual([]);
    }
  });

  it("still clears the editing host whose whole content IS what was named", async () => {
    // The shape the guard exists for — `<div contenteditable><p>…</p></div>`,
    // what Quill / ProseMirror / Lexical render on a single-paragraph document.
    // Nothing else is inside it, so nothing else can be lost.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: composerWithSiblingXml("none") }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Draft body here" }, text: "REWRITTEN", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([{ clear: true, text: "REWRITTEN" }, { key: "enter" }]);
  });

  it("refuses when the tapped element unmounts and a namesake holds focus", async () => {
    // `trackTarget`'s last resort re-runs the SELECTOR, which has no relation
    // to the element the step touched — while the identity arm in the focus
    // wait trusts what comes back absolutely, ahead of both arms that check a
    // node against `tapCandidates`. Reproduced on Chrome 151: the tapped row
    // removed on mousedown, a second field answering the same selector focused
    // beside it, and its draft emptied with a pass reported.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      // The two pre-tap settle reads see the row, so the step's frame
      // resolution lands on it — which is what makes the tap point meaningful —
      // and everything after the tap does not.
      return { xml: unmountingRowXml(reads <= 2) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Email" }, text: "replaced-by-clear", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("still clears when that row stays mounted", async () => {
    // The control: only the unmount differs, and the same selector, tap and
    // focus produce the clear the step asked for.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: unmountingRowXml(true) }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { text: "Email" }, text: "replaced-by-clear", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "replaced-by-clear" },
      { key: "enter" },
    ]);
  });

  it("refuses a namesake the TAP ITSELF creates inside the container", async () => {
    // `tap.inside` is frozen before the tap, so the ambiguity check could not
    // see an element that appears on focus — the wrapper-grows-on-focus shape
    // (Downshift, HeadlessUI, a React Native autocomplete). Reproduced on
    // Chrome 151: the appended field was emptied and rewritten, with a pass
    // reported on the wrapper.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: lateNamesakeXml(reads > 2) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email-wrapper" }, text: "REWRITTEN", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses a namesake that reports focus OUTSIDE the container's box", async () => {
    // The containment conjunct on its own. A mutation sweep found it pinned by
    // nothing: every other fixture that pairs an out-of-target focused node with
    // a small enough frame is already refused by the namesake counts, so
    // dropping `frameWithin` reddened no test. Here the counts hold — the name
    // picks out exactly one candidate under the tap, in both tree reads — and
    // containment is the only thing left to refuse on. On Android this is the
    // ordinary shape, not a contrivance: `resource-id` names the layout slot, so
    // a second row inflated from the same layout carries the same identifier
    // wherever it sits on screen.
    const calls: Call[] = [];
    const registry = mockRegistry(calls, () => ({ xml: outsideNamesakeXml }));

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email-wrapper" }, text: "REWRITTEN", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses a container that GROWS onto a field the tap never reached", async () => {
    // Candidates are frozen to the pre-tap box while containment is judged
    // against the current one, so a row growing on focus swallows a field that
    // was never a tap candidate — and the name is the only thing joining the
    // two halves. Reproduced on Chrome 151: the field below the row was
    // emptied and rewritten with a pass reported on the row.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: growingRowXml(reads > 2, true) };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "row" }, text: "new@corp.example", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses a focused field that RENAMED itself out of the namesake set", async () => {
    // A field that reformats its value on focus renames itself out of the set,
    // leaving a sibling as the unique pre-tap match — and that sibling is under
    // the tap, so the row's own mis-target passed. This is exactly the
    // currency/amount mis-target the docs say is refused.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: reformattingRowXml(reads > 2 ? "renamed" : "pre-tap") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "row" }, text: "9999", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(result.steps[0]!.reason).toContain("refusing to clear");
    expect(keyboardArgs(calls)).toEqual([]);
  });

  it("refuses the same row with no rename at all", async () => {
    // The control for the arm above: the same field takes focus, but keeps its
    // own name — so it is its own unique match, it is not under the tap, and
    // the row's second control is what refuses. Only the rename differs.
    const calls: Call[] = [];
    let reads = 0;
    const registry = mockRegistry(calls, () => {
      reads++;
      return { xml: reformattingRowXml(reads > 2 ? "kept" : "pre-tap") };
    });

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [{ kind: "type", into: { identifier: "row" }, text: "9999", clear: true }],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["fail"]);
    expect(keyboardArgs(calls)).toEqual([]);
  });
});

describe("type directive — the focus window's own edges", () => {
  it("does not call a slow-but-answering tree source an outage", async () => {
    // Every poll is given whatever is left of the window as its read budget, so
    // a read started too late is abandoned mid-flight — and booking that as
    // darkness reports "the device's tree source is down" for a source that
    // answered every time it was asked. Worse, whether the last read starts far
    // enough before the deadline to cross the tolerance depends on how the read
    // time divides into the window, so the verdict was not monotonic in
    // latency: measured on Chrome 151, the same page failed as an outage at
    // ~250ms per read while passing at 0ms, 150ms, 300ms and 400ms.
    //
    // 1400ms per read is the same shape at this file's poll interval: the first
    // read fits the window, the second cannot, and the truncation it would have
    // booked is over the tolerance.
    const calls: Call[] = [];
    const registry = mockRegistry(
      calls,
      () =>
        new Promise<{ xml: string }>((resolve) => {
          setTimeout(() => resolve({ xml: noFocusXml() }), 1400);
        })
    );

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    // "No read ever saw focus" is the documented residual the clear goes
    // through on; a tree that ANSWERED must not be reported as one that did not.
    expect(result.steps.map((s) => s.status)).toEqual(["pass"]);
    expect(keyboardArgs(calls)).toEqual([
      { clear: true, text: "new@example.com" },
      { key: "enter" },
    ]);
  });

  it("starts no tree read past the focus deadline", async () => {
    // Nothing bounded the window from above: the tests assert timing lower
    // bounds only, so letting a whole extra read start past the deadline — an
    // android-devtools `getHierarchy` or a CDP DOM walk, a real fraction of the
    // window — was invisible, while every refusal message still narrated the
    // wait as 3000ms. Two guards hold the property now (the deadline check and
    // the affordability check beside it); this pins the property.
    const calls: Call[] = [];
    const readsAt: number[] = [];
    let tapAt = 0;
    const registry = {
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
        calls.push({ id, args });
        if (id === "gesture-tap") tapAt = Date.now();
        if (id === "list-devices") return { devices: [] };
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        getHierarchy: vi.fn(async () => {
          readsAt.push(Date.now());
          return { xml: noFocusXml() };
        }),
        getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
      })),
    } as unknown as Registry;

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    asRun(await run(registry));
    // The window opens once the post-tap settle has elapsed; no read may start
    // after it closes.
    const windowClosesAt = tapAt + TYPE_FOCUS_SETTLE_MS + TYPE_FOCUS_TIMEOUT_MS;
    expect(readsAt.filter((t) => t > windowClosesAt)).toEqual([]);
    // …and it really did poll to the end, so the bound above is not vacuous.
    expect(readsAt.filter((t) => t > tapAt).length).toBeGreaterThan(2);
  });

  it("reports a genuine gesture-tap error as an error, not as a cancelled run", async () => {
    // `dispatchOrAbort` maps a rejection to the aborted skip only when the run
    // was actually cancelled. The tap is newly routed through it, and nothing
    // covered the other direction for the tap: a real transport failure has to
    // stay a step failure, or a broken device reads as a run the caller stopped.
    const calls: Call[] = [];
    const registry = {
      invokeTool: vi.fn(async (id: string, args: Record<string, unknown>) => {
        calls.push({ id, args });
        if (id === "list-devices") return { devices: [] };
        if (id === "gesture-tap") throw new Error("adb: device offline");
        return { ok: true };
      }),
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
      resolveService: vi.fn(async () => ({
        getHierarchy: vi.fn(async () => ({ xml: fieldXml("old.remembered.login") })),
        getScreenSize: vi.fn(async () => ({ width: 1080, height: 1920 })),
      })),
    } as unknown as Registry;

    await writeFlow("f", {
      executionPrerequisite: "",
      steps: [
        { kind: "type", into: { identifier: "email" }, text: "new@example.com", clear: true },
      ],
    });

    const result = asRun(await run(registry));
    expect(result.steps.map((s) => s.status)).toEqual(["error"]);
    expect(result.steps[0]!.reason).toContain("device offline");
    expect(keyboardArgs(calls)).toEqual([]);
  });
});
