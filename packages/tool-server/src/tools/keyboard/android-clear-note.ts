import type { AndroidClearOutcome } from "../../utils/android-input";
import type { SetTextReason } from "../../blueprints/android-devtools";

/**
 * Why the atomic accessibility replace did not run, on top of the reasons the
 * helper itself reports.
 *
 * - `helper_unavailable` — nothing was holding the devtools connection and it
 *   could not be started inside the attempt's budget.
 * - `helper_outdated` — the helper answering on this device predates `setText`.
 *   Reachable even with a current bundle: the process holding the connection is
 *   whatever started first, possibly from another argent install.
 * - `rpc_failed` — a round trip to the helper rejected: a severed socket, a
 *   helper that died after the service resolved, or one that stopped answering
 *   and hit the RPC client's own timeout.
 *
 * Not exported: it exists to give these three their own docblock, and the union
 * below is what every caller actually names.
 */
type AtomicClearSkip = "helper_unavailable" | "helper_outdated" | "rpc_failed";

export type AndroidClearSkipReason = AtomicClearSkip | SetTextReason;

const WHY: Record<AndroidClearSkipReason, string> = {
  helper_unavailable:
    "argent's Android devtools helper is not running on this device and could not be started",
  helper_outdated: "the devtools helper answering on this device is too old to know the method",
  rpc_failed: "the call to the devtools helper failed",
  no_focused_input: "the helper found no focused input field",
  not_editable: "the focused element is not an editable text field",
  action_refused: "the focused field refused the accessibility replace",
  action_threw: "the focused field went away while the replace was being applied",
  unverifiable: "the replace was applied but the field could not be read back to confirm it",
  value_mismatch: "the replace was applied but the field read back holding something else",
};

/**
 * What the caller says when the atomic write MAY ALREADY BE IN THE FIELD, so the
 * injected path that follows is a second write rather than the first.
 *
 * Decided from the helper's own `applied` flag rather than from the reason's
 * NAME. The two are the same for the reasons this build knows — `unverifiable`
 * and `value_mismatch` are exactly the pair the helper sets `applied` on — but
 * not for the two shapes that reach here from outside that table: a reply that
 * carries `applied: true` with no reason at all, and a reason from a helper
 * newer than this build. A name-keyed set answers "nothing was written" for
 * both, which is the one answer that must not be guessed.
 *
 * It also needs a SECOND write to exist. A clear-only call has none — the
 * fallback deletes — and the accepted replace wrote the empty string, so both
 * writes agree and there is nothing to double. Saying it anyway put "the
 * fallback's text added to it" on a call that carried no text.
 */
const DOUBLED =
  " The accessibility replace had already been ACCEPTED by the widget when this ran, so if it " +
  "landed after all, the field may now hold that value with the fallback's text added to it.";

/**
 * What the injected path did, and what it therefore cannot promise.
 *
 * Each arm names the WEAKNESS of that path rather than restating the mechanics:
 * the caller is being told this because the verified path did not run, so the
 * only useful content is what is now unverified and how it can be wrong.
 */
const WHAT: Record<AndroidClearOutcome["path"], string> = {
  "select-all": "the select-all chord followed by a delete",
  "select-all-kept":
    "the select-all chord alone, with the `text` replacing the selection so the field was never " +
    "observed empty mid-call. Nothing verified that the chord took: with text following there is " +
    "no residue to check, and a widget that swallows the chord (a Flutter `TextField` does) keeps " +
    "its whole value with the new text spliced in at the caret",
  "select-all-rescued":
    "the select-all chord, a delete, and then a backspace run over what the field still reported " +
    "afterwards. That reading is not proof the chord failed: the view hierarchy reports an empty " +
    "field's placeholder in the same attribute as its value, so a field the chord DID empty reads " +
    "the same as one it did not",
  "delete-run":
    "a backspace run, because this Android level has no `input keycombination`. That deletes " +
    "backwards from end-of-LINE, so a multi-line field keeps whatever sits below the caret",
};

/**
 * What the read-back after the delete actually saw, which only `select-all` has
 * to answer.
 *
 * Three read-backs reach that path and just one of them saw an empty field. A
 * screen the reader could not capture, and a focused field it could not measure
 * — a password box — both leave the fast path alone in exactly the same way. A
 * note that reports all three as "read back, and empty" tells the caller the
 * credential box is clear while the credential is still in it.
 */
const READ_BACK_EMPTY = " The field was read back afterwards and nothing was left to remove.";

const READ_BACK_UNAVAILABLE =
  " Nothing confirmed the chord took: the field could not be read back — either the screen would " +
  "not capture, or the focused field cannot be measured, which is what a password box always is.";

const REMEDY = " Read the field back if the exact value matters.";

/**
 * The same advice for a request whose text came from a `{{secret:…}}`
 * placeholder.
 *
 * "Read the field back" is the one thing an agent must not do there: the box
 * holds a credential, the tool skips its own after-typing screenshot for that
 * reason, and `argent-device-interact` tells the agent to submit or navigate
 * away rather than `describe` such a field. Sending the ordinary remedy with the
 * skipped-screenshot notice in the same response contradicts both.
 */
const SECRET_REMEDY =
  " This field was filled from a secret, so do not read it back with `describe` or a screenshot. " +
  "Confirm it by the app's own result instead.";

const BLIND =
  " The field's length could not be read, so a fixed run of backspaces was sent instead of a " +
  "sized one; a longer field keeps its head.";

/**
 * The `note` an Android `keyboard` result carries when the atomic clear was not
 * the one that ran.
 *
 * Called only on that path, so it always returns a string; the backend omits the
 * field entirely when the atomic clear DID run. A verified replace has nothing
 * to warn about, and a note on every clear is a note nobody reads — which is
 * what makes its absence worth something.
 *
 * Deliberately never quotes the field's contents or its length. A `{{secret:…}}`
 * request is typed into the box that already holds a credential, and this string
 * travels into the agent's transcript and the tool-server's logs;
 * `redactSecretsFromError` substitutes the resolved value and could not redact a
 * count. Everything here is derived from WHICH path ran, never from what it read.
 *
 * `secret` changes the closing advice for the same reason — see SECRET_REMEDY.
 */
export function androidClearNote(
  reason: AndroidClearSkipReason,
  outcome: AndroidClearOutcome,
  {
    applied = false,
    fallbackText = false,
    secret = false,
  }: { applied?: boolean; fallbackText?: boolean; secret?: boolean } = {}
): string {
  // `WHY` is keyed by a closed union, but the reason crosses an RPC boundary
  // from a helper that may be NEWER than this tool-server — a protocol-3 reason
  // this build has never heard of would otherwise render as literal
  // "(undefined)". The gate upstream only checks the helper is not too OLD.
  //
  // Own-property check, not `??`: `reason` is a free string off the wire, so an
  // inherited key resolves through `Object.prototype` and never reaches the
  // fallback — `constructor` rendered the whole native function into the note.
  // Same guard, for the same reason, as `resolveAndroidNamedKeycode`.
  const why = Object.hasOwn(WHY, reason)
    ? WHY[reason]
    : "the helper declined it for a reason this version does not recognise";
  return (
    `keyboard clear: the atomic accessibility replace was not used (${why}), so the ` +
    `field was cleared with ${WHAT[outcome.path]}.` +
    (outcome.path === "select-all"
      ? outcome.readBackEmpty
        ? READ_BACK_EMPTY
        : READ_BACK_UNAVAILABLE
      : "") +
    (outcome.blindDeleteRun ? BLIND : "") +
    (applied && fallbackText ? DOUBLED : "") +
    (secret ? SECRET_REMEDY : REMEDY)
  );
}
