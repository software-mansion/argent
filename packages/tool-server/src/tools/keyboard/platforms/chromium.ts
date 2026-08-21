import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import { chromiumCdpRef, type ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import { clearChromiumField, newTargetHandle, releaseParkedTarget } from "../chromium-clear";
import { CHROMIUM_NAMED_KEYS, charToChromiumKey } from "../chromium-keys";
import { deviceChainKey, serializePerDevice } from "../device-chain";
import { sleepOrAbort } from "../../../utils/timing";
import type { KeyboardParams, KeyboardResult } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runChromium(
  api: ChromiumCdpApi,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  const delay = params.delayMs ?? 50;
  let keysPressed = 0;

  // Resolve the named key BEFORE anything is dispatched, because `clear` empties
  // the field: a `{ clear, key: "bogus" }` must reject with the field still
  // intact rather than emptied and then 400. (Not to protect the text — the tool
  // rejects `{ text, key }` above the dispatch, so a key never follows typing in
  // the same call.)
  let named: (typeof CHROMIUM_NAMED_KEYS)[string] | undefined;
  if (params.key) {
    const lower = params.key.toLowerCase();
    // Own-property check: a prototype key like "constructor" would otherwise
    // pass the falsy guard with a garbage value and dispatch a broken CDP key
    // event instead of rejecting as an unknown key.
    named = Object.hasOwn(CHROMIUM_NAMED_KEYS, lower) ? CHROMIUM_NAMED_KEYS[lower] : undefined;
    if (!named) {
      // Well-typed but unusable input (`key` is a free string) — a caller
      // mistake mapped to 400 (matching the Android path, uniform across
      // backends), keeping the KEYBOARD_KEY_UNSUPPORTED telemetry code (#420).
      throw new InvalidToolInputError(
        `Unknown key "${params.key}". Supported: ${Object.keys(CHROMIUM_NAMED_KEYS).join(", ")}`,
        {
          error_code: FAILURE_CODES.KEYBOARD_KEY_UNSUPPORTED,
          failure_stage: "keyboard_named_key_chromium",
          error_kind: "unsupported",
        }
      );
    }
  }

  // Resolve EVERY character before touching the page: no device write happens
  // until the whole request is known to be executable. Resolving per character
  // inside the loop below would let a `{ clear, text }` whose character 4 has no
  // CDP descriptor destroy the field's original value and leave a fragment
  // behind, so a call that returned 400 would leave the caller worse off than
  // before it. Same up-front-validation rule the android backend applies with
  // `assertTypeableAndroidText`.
  const descs = params.text
    ? [...params.text].map((char) => ({ char, desc: charToChromiumKey(char) }))
    : [];
  // How many characters the split check below can hold the field to: the ones
  // before the first `\n`, `\r` or `\t`, or all of them when `text` carries
  // none.
  //
  // Those three are not characters on this backend: `charToChromiumKey` maps
  // them to the Enter and Tab descriptors, so they are dispatched inside the
  // typing loop as the physical keys they are, and they can move focus BY
  // DEFINITION — the reason the split check also excludes a named `key`.
  // Anything sent AFTER one of them may therefore land in a different field
  // because the request asked for exactly that, which is why the guarantee stops
  // there. Without that stop the SAME Enter succeeded as a named `key` and
  // failed spelled as `\n`: measured on Chrome 151 against a search box that
  // submits, empties and blurs (the shape the check's own comment cites),
  // `{ clear, text: "query\n" }` raised a 500 naming a split 3/3 while the page
  // had done exactly what was asked — and the control, the same Enter sent as
  // `{ clear, key: "enter" }` after a `{ clear, text: "query" }`, passed.
  //
  // What it no longer does is drop the check for the WHOLE call. `descs.some`
  // tested the whole string and skipped every character, so one newline in a
  // `<textarea>` — where a newline is ordinary content that moves nothing —
  // switched the guarantee off for a value of any length. Measured on Chrome 151
  // against an exact control pair differing only by one `\n`, in a textarea
  // whose 4th `input` moves focus to a neighbour: `{ clear, text: "aaaabbbb" }`
  // correctly reported the split, `{ clear, text: "aaaa\nbbbb" }` returned
  // `cleared: true`, and both left the same `["aaa", "abbbb"]` behind.
  //
  // Counting the PREFIX keeps both: the search box delivers all 5 of `query`
  // before its Enter and still passes, while the textarea delivers 3 of the
  // first 4 and fails. It cannot see a split that happens after the Enter, which
  // is the part no evidence here can separate from the focus move the caller
  // asked for.
  const firstMovesFocus = descs.findIndex(
    ({ char }) => char === "\n" || char === "\r" || char === "\t"
  );
  const guaranteed = firstMovesFocus < 0 ? descs.length : firstMovesFocus;
  for (const { char, desc } of descs) {
    if (!desc) {
      // A character with no CDP descriptor can't be typed — caller input error
      // → 400, keeping the KEYBOARD_CHARACTER_UNSUPPORTED telemetry code (#420).
      throw new InvalidToolInputError(`No CDP key descriptor for character "${char}"`, {
        error_code: FAILURE_CODES.KEYBOARD_CHARACTER_UNSUPPORTED,
        failure_stage: "keyboard_char_chromium",
        error_kind: "unsupported",
      });
    }
  }

  // Clear before text. `clearChromiumField` refuses up front if nothing
  // editable holds focus, and throws when it OBSERVES the value survive — so
  // reaching the typing loop means the field was either seen empty or could not
  // be read at all (a cross-origin iframe, a detached node). It never means the
  // field was seen to still hold its value.
  //
  // The handle is owned here, not inside the clear, because the parked element
  // has to outlive the typing: focus is asked about twice, once immediately
  // before the first character and once after the last, and the `finally`
  // guarantees the element is let go either way.
  const handle = params.clear ? newTargetHandle() : undefined;
  const typing = descs.length > 0 || named !== undefined;
  let released = false;
  let clearedLabel: string | undefined;
  // Whether the clear saw a password field. The split message below applies the
  // same withhold-the-count rule, and the read it can see is the LATER one — a
  // show/hide control that switches the field to `type="text"` while the
  // characters go out reports a plain box there.
  let clearedSecret = false;
  const releaseTarget = async () => {
    released = true;
    return releaseParkedTarget(api, handle!);
  };

  try {
    if (handle) {
      // Checked before the clear and never inside it, for the same reason the iOS
      // backend keeps its own clear atomic: the chord selects the field's whole
      // value, so stopping between the select-all and the delete would leave that
      // selection armed for whatever types next, and a cancelled request has no
      // reader to be told so.
      signal?.throwIfAborted();
      // The clear settles between its key dispatch and its read-back, so the
      // focus answer is the last thing before the loop below. `delay` is passed
      // only as a FLOOR on that settle — a caller asking for a slower cadence
      // gets a longer wait, but a fast one cannot shrink the window the verdict
      // rests on (see CLEAR_SETTLE_MS).
      const outcome = await clearChromiumField(api, handle, delay, params.secretText === true);
      clearedLabel = outcome.label;
      clearedSecret = outcome.secret === true;
      // Emptying a field routinely moves focus off it — a field that blurs once
      // empty, an app that advances to the next input, a re-render. The keys
      // below are dispatched at the PAGE, not at an element, so they would then
      // land wherever focus went: nowhere at all (the value the caller asked
      // for is simply gone), or appended to a different field. Both were
      // observed on Chrome 150, and both returned the same
      // `{typed, keys, cleared}` a real replacement returns, so the caller
      // could not tell them apart.
      //
      // The clear itself already happened and is not undoable, so this reports
      // the split outcome rather than pretending either half. `keptFocus` is
      // undefined when the page could not be read — that stays best-effort,
      // like the emptiness check.
      if (typing && outcome.keptFocus === false) {
        throw new FailureError(
          `keyboard: ${outcome.label ?? "the field"} was emptied, but it no longer holds focus ` +
            `afterwards — the page moved focus in response to the clear (a field that blurs when ` +
            `empty, or an app that advances to the next input). Nothing was typed and no key was ` +
            `pressed, because either would have gone to whatever holds focus now rather than to ` +
            `that field. Tap the field again and send the rest of the request without \`clear\` — ` +
            `the field is already empty.`,
          {
            // Its own code, not INEFFECTIVE: the field WAS emptied here, and
            // INEFFECTIVE means it was not. A client keying on the signal has
            // to tell "re-clear required" from "the field is already empty,
            // send the rest without `clear`" — and `failure_stage`, the only
            // thing that separated them, never reaches the wire (`http.ts`
            // serializes `error_code` and `error_kind` only).
            error_code: FAILURE_CODES.KEYBOARD_CLEAR_FOCUS_LOST,
            failure_stage: "keyboard_clear_focus_lost_chromium",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        );
      }
    }

    // The signal is checked BETWEEN characters and the cadence wait yields to it,
    // so a client that hangs up mid-call stops within about one keypress instead
    // of typing the whole `text` out and holding this device's chain for the rest
    // of the run. Never between a character's own three events: CDP is only awaits
    // and sleeps, so there is nothing to interrupt there except the delivery of
    // the `char` this keyDown already announced.
    for (const { desc } of descs) {
      signal?.throwIfAborted();
      await api.dispatchKeyEvent({
        type: "keyDown",
        key: desc!.key,
        code: desc!.code,
        windowsVirtualKeyCode: desc!.windowsVirtualKeyCode,
      });
      // `char` delivers the actual codepoint to the focused input; without
      // this the field receives no value.
      await api.dispatchKeyEvent({ type: "char", text: desc!.text });
      await api.dispatchKeyEvent({
        type: "keyUp",
        key: desc!.key,
        code: desc!.code,
        windowsVirtualKeyCode: desc!.windowsVirtualKeyCode,
      });
      keysPressed++;
      await sleepOrAbort(delay, signal);
    }

    // One sample before the loop cannot cover a blur that lands DURING it: the
    // characters go out `delay` apart, so a page that moves focus part-way
    // through splits the value across two fields. Measured on Chrome 150, where
    // a field blurring 300ms after emptying left `us` in the target and
    // `er@example.comOTHER-FIELD` in its neighbour, reported as a clean
    // replacement. Asking the same parked element again is what turns that into
    // a failure the caller can see; it also releases the element.
    //
    // Focus loss ALONE is not that evidence, and treating it as such made this
    // fire on requests where every character landed where it was asked to.
    // Measured on Chrome 150, all reproduced 4-5/5:
    //
    //   - `{ clear, text }` on a field that advances focus once its value is
    //     complete (the OTP / card-number pattern) — the whole value in the
    //     target, the neighbour empty, and a "split across fields" 500;
    //   - `{ clear, key: "tab" }` — Tab moves focus BY DEFINITION and dispatches
    //     no character at all, so this combination could never succeed;
    //   - `{ clear, key: "enter" }` on a search box that blurs on submit — the
    //     ordinary "replace the query and submit" shape.
    //
    // So the check is narrowed on both axes. A named `key` never reaches it,
    // because `guaranteed` counts characters and a key-only request has none:
    // one key event cannot be split across two fields, while for `tab`/`enter`
    // the focus move IS the requested effect, so a `{ clear, key: "enter" }`
    // against the ordinary "send and reset" handler — a search box, a chat
    // composer, a tag input, all of which empty the field and blur it on
    // submit — must come back clean rather than as a 500 naming a split that did
    // not happen. `text` carrying `\n`/`\r`/`\t` ends the guarantee at that
    // character for exactly that second reason — see `guaranteed`, which is the
    // same physical key arriving by a different spelling, and everything before
    // it is still held to. (`text` and `key` never arrive together: the tool
    // rejects that shape above the dispatch, so the block below this one is
    // unreachable in the same call as the loop above it.)
    //
    // For characters the evidence is PROVENANCE, corroborated by the value:
    // `delivered` counts the insertions the parked element itself received, and
    // the failure needs both a shortfall there and a value that is wrong. A
    // single focus sample was neither necessary nor sufficient, and each half of
    // the old rule was defeated by an ordinary page (both measured on Chrome 151,
    // 3/3, both reported as a clean `cleared: true` replacement):
    //
    //   - focus that LEAVES and COMES BACK. The sample was taken after the last
    //     character, so a loss that did not persist to that instant was
    //     invisible: an autosuggest-shaped handler left `aefgh` in the target and
    //     `bcd` in the neighbour with focus restored.
    //   - a field that REVERTS on blur (an editable data grid, a click-to-edit
    //     title, a controlled input rejecting a value). It ends up holding MORE
    //     characters than were sent, so "fewer than dispatched" could not fire —
    //     while holding its exact pre-clear value, which makes `cleared` flatly
    //     false. Hence `reverted` as the second way for the value to be wrong.
    //
    // Requiring both signals is what keeps the benign shapes out. A page that
    // NORMALISES what it receives — stripping separators
    // (`value.replace(/\D/g, "")`), trimming, upper-casing — holds a shorter
    // value legitimately, and every character was still delivered to it, so it no
    // longer fires (it did before, and could not be separated from a split by the
    // count alone). A page that LENGTHENS it (an input mask, an autocompleter)
    // was already excluded and still is. Conversely a page that hides the
    // deliveries by calling `stopPropagation` on `beforeinput` is saved by the
    // value half, since the characters it swallowed the events for are in the
    // field.
    if (handle && guaranteed > 0) {
      const after = await releaseTarget();
      const landed = after?.length ?? 0;
      // -1 means the count could not be read at all, so fall back to the focus
      // sample rather than inventing evidence either way.
      //
      // That fallback is what still excludes the WHOLE call when `text` carries
      // an Enter or a Tab: a focus sample cannot tell "the page split the value"
      // from "the Enter I was asked to send submitted the form and blurred the
      // field", which is the false positive this exclusion was added for. The
      // prefix rule replaces it only where there is provenance to replace it
      // with — a readable delivery count, which says how many characters reached
      // the parked element regardless of what the Enter then did.
      const delivered =
        after?.delivered !== undefined && after.delivered >= 0 ? after.delivered : undefined;
      const shortDelivery =
        delivered !== undefined
          ? delivered < guaranteed
          : guaranteed === descs.length && after?.focused === false;
      // A field at its own `maxlength` is the standing exclusion, and the one the
      // OTP note above got wrong: the pattern it was measured against is the
      // SINGLE-field variant, where the whole value fits. A SEGMENTED one — six
      // `<input maxlength="1">` boxes with the standard auto-advance handler,
      // which is how essentially every 2FA code, PIN and split card number is
      // built — holds 1 of N BY DESIGN, and receives 1 delivery of N as well, so
      // neither signal can tell it from a split. A field that cannot hold another
      // character explains its own short value.
      const valueWrong = landed < guaranteed || after?.reverted === true;
      if (after?.tracked && shortDelivery && valueWrong && !after.full) {
        // Both halves of the count are credential material: the field's own
        // length when it is a password input, and the REQUEST's length when the
        // text came from a `{{secret:…}}` placeholder — which a plain
        // `type="text"` box takes just as often (an API key, a TOTP code, a
        // password field a show/hide control has toggled to text).
        // Counted against what was checked, not against what was sent: with an
        // Enter or a Tab in `text` those differ, and quoting the request's own
        // length there would name characters this never had an opinion about.
        const upTo =
          guaranteed < descs.length
            ? ` before the first Enter/Tab of the ${descs.length} sent`
            : ``;
        const reached =
          after.secret || clearedSecret || params.secretText
            ? `not all of the text reached`
            : `only ${delivered ?? landed} of the ${guaranteed} character(s)${upTo} reached`;
        // The revert is worth its own sentence: it is the state in which
        // `cleared` would have been flatly false.
        const holds = after.reverted
          ? ` That field now holds the value it held BEFORE the clear, so it was not replaced at all.`
          : ``;
        throw new FailureError(
          `keyboard: ${reached} ${clearedLabel ?? "the field"} — the page moved focus away from it ` +
            `while the text was being typed, so the rest of the value most likely landed wherever ` +
            `focus went.${holds} This was not a clean replacement — re-read the screen before ` +
            `continuing.`,
          {
            // Same reason as the sibling above: the clear itself worked, and
            // what failed is where the characters went.
            error_code: FAILURE_CODES.KEYBOARD_CLEAR_FOCUS_LOST,
            failure_stage: "keyboard_clear_focus_lost_typing_chromium",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        );
      }

      // The one shape the pair above cannot see, because both halves agree the
      // WRONG way. `delivered` is provenance — a capture listener sees the
      // `beforeinput` whether or not the element's own handler then cancels it,
      // which is exactly what makes it the right evidence for "did focus move".
      // It says nothing about EFFECT: a field that refuses every insertion in
      // place reads as fully delivered while nothing enters it, so
      // `shortDelivery` is false and the throw above cannot fire. Measured on
      // Chrome 148 against `<input value="old-value-seeded">` whose `beforeinput`
      // handler `preventDefault()`s every `insert*`, focus retained:
      // `{ clear: true, text: "abc" }` returned `{ typed: "abc", keys: 3,
      // cleared: true }` over an EMPTY field.
      //
      // `applied` is the effect half — Blink fires `input` only for an insertion
      // it carried out. The condition is deliberately the total corner: every
      // character arrived, not one took effect, and the field holds nothing. A
      // page that refuses SOME insertions is normalising (stripping separators,
      // rejecting a character class), which is the false-failure class this whole
      // measurement is narrowed to keep out, and a page that writes the value
      // itself after cancelling the event leaves the field non-empty, so neither
      // reaches here.
      //
      // Reported as its own outcome rather than through the focus message above:
      // focus never moved, so nothing was split across fields, and the caller
      // needs to know the field is EMPTY rather than go looking for the value in
      // a neighbour.
      const applied =
        after?.applied !== undefined && after.applied >= 0 ? after.applied : undefined;
      const refusedInPlace =
        after?.tracked === true &&
        !after.full &&
        delivered !== undefined &&
        delivered >= guaranteed &&
        applied === 0 &&
        landed === 0;
      if (refusedInPlace) {
        throw new FailureError(
          `keyboard: ${clearedLabel ?? "the field"} was emptied, but the page refused every ` +
            `character that was then typed into it — each one was delivered to that field and ` +
            `cancelled there, so the field is now EMPTY rather than holding the requested value. ` +
            `This is a field that rejects what it is given (a controlled or validating input). ` +
            `Nothing about it is retryable by typing again; read the screen and enter the value ` +
            `the way the app expects.`,
          {
            // Not FOCUS_LOST — focus was retained throughout, and not INEFFECTIVE,
            // which means the clear itself did not take. The clear worked; what
            // was refused is the typing.
            error_code: FAILURE_CODES.KEYBOARD_TEXT_REFUSED,
            failure_stage: "keyboard_text_refused_chromium",
            failure_area: "tool_server",
            error_kind: "unsupported",
          }
        );
      }
    }

    // Key after the CLEAR — not after the text, which never accompanies it: the
    // tool rejects `{ text, key }` above the dispatch, so this block and the
    // typing loop above are mutually exclusive. What the position still buys is
    // `{ clear, key: "enter" }`, where pressing the key before the field is
    // emptied would submit the value the caller asked to be replaced.
    if (named) {
      // Checked before the press, not inside it: cutting the wait between the key's
      // Down and its Up would leave the page holding a key nothing releases.
      signal?.throwIfAborted();
      await api.dispatchKeyEvent({
        type: "keyDown",
        key: named.key,
        code: named.code,
        windowsVirtualKeyCode: named.windowsVirtualKeyCode,
      });
      await sleep(delay);
      await api.dispatchKeyEvent({
        type: "keyUp",
        key: named.key,
        code: named.code,
        windowsVirtualKeyCode: named.windowsVirtualKeyCode,
      });
      keysPressed++;
    }
  } finally {
    // Never leave the slot behind: it is the sole retainer of the parked node,
    // and a per-call name means a leaked one is never overwritten by the next
    // clear.
    if (handle && !released) await releaseTarget().catch(() => undefined);
  }

  return {
    typed: params.text ?? params.key ?? "",
    keys: keysPressed,
    ...(params.clear ? { cleared: true } : {}),
  };
}

export function makeChromiumImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    handler: async (_services, params, device, options) => {
      const ref = chromiumCdpRef(device);
      const chromium = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
      // Serialized per device, because a run holds the parked element and the
      // emptied field across many CDP round trips — the clear, the settle, the
      // read-back, then one dispatch per character. A concurrent run types into
      // that window and both calls report a clean replacement: measured on this
      // branch, two `{ clear, text }` calls of `AAAA` and `BBBB` at 0ms left
      // `ABABABAB` in the field with both returning `cleared: true` and their
      // own four characters as `typed`. See `serializePerDevice`.
      //
      // The service is resolved BEFORE the queue, so a device whose CDP session
      // has to be established does not hold the chain while it connects.
      return serializePerDevice(deviceChainKey(device.id), () => {
        // Checked HERE, as this call's turn comes round, so a request the client
        // has already abandoned does not spend the device's keyboard — and then
        // carried INTO the run, which is the rest of the same abandonment window:
        // a long `{ clear, text }` that starts a moment before the hang-up would
        // otherwise type every remaining character and hold the chain for all of
        // it. The CDP transport is only awaits and sleeps, so it is fully
        // cancellable, as the iOS backend's per-character checks already are.
        options?.signal?.throwIfAborted();
        return runChromium(chromium, params, options?.signal);
      });
    },
  };
}
