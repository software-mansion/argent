import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  isLiveServiceState,
  type DeviceInfo,
  type Registry,
} from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isAndroidTv } from "../../../utils/adb";
import {
  androidDevtoolsRef,
  SET_TEXT_MIN_PROTOCOL,
  type AndroidDevtoolsApi,
} from "../../../blueprints/android-devtools";
import {
  assertTypeableAndroidText,
  injectAndroidClear,
  injectAndroidNamedKey,
  injectAndroidText,
  resolveAndroidNamedKeycode,
  type AndroidClearOutcome,
} from "../../../utils/android-input";
import { deviceChainKey, serializePerDevice } from "../device-chain";
import type { KeyboardParams, KeyboardResult } from "../types";
import { androidClearNote, type AndroidClearSkipReason } from "../android-clear-note";
import { typeTv } from "./tv";

/**
 * Ask the `android-devtools` helper for the hierarchy the legacy clear needs to
 * size its delete run — but only while that helper is ALREADY up.
 *
 * The device serves one UiAutomation connection, and this helper is its usual
 * holder: `describe` prefers it, and it keeps the connection for ~60s per call
 * (measured 61.2s on API 30). Every `uiautomator dump` inside that window comes
 * back `Killed`, so the clear's measurement fails and it falls to a fixed blind
 * count that truncates a long field — with `describe` → tap → `keyboard` being
 * the ordinary call order, not an edge case. Reading from the holder instead of
 * racing it is what makes the measurement work at all there.
 *
 * Gated on the service already being live so a clear never pays for spawning
 * (or installing) the helper: with it down there is no contention, and the dump
 * this falls back to is exactly what ran before.
 *
 * `isLiveServiceState` counts STARTING as live, which is right when ANOTHER
 * caller is spawning the helper — joining that init beats racing the holder it
 * is about to become. It is wrong for the one caller that started it in THIS
 * call and gave up: the node it would see is its own, the init it would await is
 * the one the atomic attempt already abandoned, and the premise above ("with it
 * down there is no contention") does not hold for it. That caller passes no
 * reader at all — see `runAndroidPhoneType`.
 *
 * What this costs OTHER tools, which is new with this reader: `keyboard` becomes
 * a client of the same `AndroidDevtools:<serial>` service `describe` uses, and
 * `utils/android-devtools-client.ts` serialises every RPC onto one host-side
 * chain. `readHierarchy` gives up on this read after PREFERRED_READ_BUDGET_MS
 * with a `Promise.race`, but the RPC underneath is abandoned rather than
 * cancelled — the client exposes no cancel — so the chain does not advance until
 * the helper answers or its own LONG_RPC_TIMEOUT_MS elapses. A `describe` issued
 * on the same serial in that window therefore queues behind a read the clear has
 * already stopped waiting for, and can wait out the remainder of that timeout
 * before its own request is even sent. It needs a helper that is alive and slow
 * to answer, which is also the only state in which the clear abandons a read at
 * all; cancelling it properly means giving the shared RPC client a cancel path.
 */
function devtoolsHierarchyReader(
  registry: Registry,
  device: DeviceInfo
): () => Promise<string | undefined> {
  return async () => {
    const ref = androidDevtoolsRef(device);
    try {
      if (!isLiveServiceState(registry.getServiceState(ref.urn))) return undefined;
    } catch {
      // Never resolved on this device — nothing is holding the connection.
      return undefined;
    }
    const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
    // The helper caches accessibility nodes and can serve stale text after the
    // inspected app changed it, which is precisely what this reads.
    const { xml, windowCount, truncated } = await devtools.getHierarchy({ clearCache: true });
    // A dump ANNOUNCES a failed capture — a refused screen prints `ERROR:`, a
    // lost race prints `Killed`, neither carrying the `<hierarchy` tag the caller
    // tests for. The helper does not: `captureXml` writes its `<hierarchy
    // rotation="…">` wrapper unconditionally, including when it saw no windows
    // at all and when the walk stopped early — so a content-free reply PASSES
    // that test, both dump attempts are skipped, and the clear silently becomes
    // the blind delete count that truncates a long field.
    //
    // These are the two signals that tell those replies apart, and this is the
    // only layer that can see them (`readHierarchy` is handed a string). Both
    // mean "ask the dump instead", which is exactly what ran before the helper
    // was consulted at all.
    if (windowCount === 0 || truncated) return undefined;
    return xml;
  };
}

/**
 * How long the atomic attempt will wait for the helper to START. It does NOT
 * cover the two RPCs that follow — see below.
 *
 * It is a CEILING on a path that is allowed to fail, not a sizing: a warm device
 * is far inside it (measured on a Pixel 3a / API 36 with the helper already
 * installed: 39-100ms for the install probe, then 486-1304ms from
 * `am instrument` to the helper announcing its port, and 54-73ms for the whole
 * `{ clear, text }` tool call once it is up). The point of the bound is the
 * device where the helper never starts at all: the blueprint's own limits there
 * are a 60s `adb install` plus a 30s readiness wait, and paying those before
 * every clear would turn a working `keyboard` into an unusable one. Whatever
 * this abandons keeps running underneath, so the cost is paid once and the NEXT
 * clear finds the helper already up.
 *
 * Sized well clear of the measured worst case rather than tight to it, because
 * losing the race is not free — it spends the budget AND then runs the injected
 * clear, which keeps its own separate ANDROID_CLEAR_BUDGET_MS. What stops that
 * cost repeating on a device where the helper can NEVER start is
 * ATOMIC_START_COOLDOWN_MS, not this: the registry does not remember a failed
 * service, so without it every clear would pay this budget again, forever.
 *
 * The `ping` and `setText` calls after it are bounded by the RPC client's own
 * timeouts, not by this: 5s for `ping` (DEFAULT_RPC_TIMEOUT_MS) and 15s for
 * `setText`, which shares `getHierarchy`'s LONG_RPC_TIMEOUT_MS because
 * abandoning a WRITE does not stop the device. So a helper that accepts the
 * socket and then goes silent costs up to 20s on top of this budget. They are
 * deliberately not raced down further: the client serialises every RPC onto one
 * host-side chain and exposes no cancel, so abandoning a request in flight does
 * not free the chain — it just hides the wait from this caller and hands it to
 * whatever `describe` runs next (the hazard already written up on
 * `devtoolsHierarchyReader`). A bound that only moves the cost is worse than the
 * client's own.
 */
const ATOMIC_CLEAR_BUDGET_MS = 8_000;

/**
 * How long a device whose helper could not serve the atomic clear is left alone
 * before the atomic path tries again.
 *
 * The registry keeps no memory of a failed service: `_initialize` moves the node
 * to ERROR and nulls its `initPromise`, and the next `resolveService` walks
 * straight past that into a fresh STARTING (`packages/registry/src/registry.ts`).
 * `describe` can afford that — it has no second path and must try. A clear does
 * have one, so without a cooldown a device that cannot run the helper at all (a
 * physical device refusing `am instrument`, an image the APK will not install
 * on) turns every `keyboard { clear }` from ~1s into ~9s, permanently, for a
 * path that is never going to work.
 *
 * A cooldown rather than a permanent skip because the cause is often temporary —
 * a device still booting, adb reattaching, a helper another process had wedged —
 * and a `keyboard` that silently stopped preferring the verified clear for the
 * rest of the tool-server's life would be worse than a slow one. A minute is
 * long enough that a broken device pays the probe about once per minute instead
 * of once per call, and short enough that a device which comes good is picked up
 * within the same session.
 *
 * Two things are recorded, and one deliberately is not.
 *
 * A start that REJECTS is recorded whenever it rejects — including long after
 * this call gave up on it. Recording only the rejections that beat the budget
 * would arm the cooldown for the fast failures and leave it unarmed for exactly
 * the slow ones it exists for: the failures this constant names are all slower
 * than the budget (the blueprint's own limits are a 60s `adb install` plus a 30s
 * readiness wait), so a start failing half a second past it left every clear
 * paying the full budget and starting a fresh install, forever.
 *
 * A helper that ANSWERS the socket and then does not answer the call is recorded
 * too — see WEDGED_RPC_MS. It is the more expensive state, not a cheaper one:
 * the RPC timeouts it burns are longer than the start budget.
 *
 * What is NOT recorded is a start that merely outran the budget and is still
 * running. The next call joins that same in-flight initialisation (the registry
 * hands back its `initPromise` while the node is STARTING) rather than beginning
 * another — so it is on course to succeed, and penalising it would skip the
 * atomic path on exactly the slow-but-working device the budget was widened for.
 */
const ATOMIC_START_COOLDOWN_MS = 60_000;

/**
 * How slow a FAILED round trip has to be before the helper counts as wedged
 * rather than gone.
 *
 * A live helper answers in well under a second, and a helper that has died or
 * closed its socket rejects immediately. What sits between is the state
 * `AndroidClearOptions.readHierarchy` already names — alive, holding the
 * device's single UiAutomation connection, and not answering — where the only
 * way out is the RPC client's own timeout: 5s for `ping`, 15s for `setText`.
 * Nothing else absorbs that, so without a cooldown every clear pays it again.
 *
 * Sized between the two rather than at either: far above any real answer, far
 * below the shortest timeout, so a fast rejection (which costs nothing to retry)
 * does not arm the cooldown.
 */
const WEDGED_RPC_MS = 2_000;

/** Serial → when its helper last failed the atomic clear. See ATOMIC_START_COOLDOWN_MS. */
const atomicStartRefusedAt = new Map<string, number>();

/**
 * Drop the cooldown marks. Test-only, and matching
 * `__resetAndroidDevtoolsInstallCache` — the map is deliberately module-level so
 * one refusal is remembered across requests, which in a suite means one test's
 * refusal is remembered into the next and silently skips the atomic path there.
 */
export function __resetAtomicClearCooldown(): void {
  atomicStartRefusedAt.clear();
}

/**
 * The helper for this device, starting it if nothing is holding the connection.
 *
 * Deliberately NOT gated on {@link isLiveServiceState} the way
 * `devtoolsHierarchyReader` is. That gate exists so a clear never pays to spawn
 * the helper for a MEASUREMENT it can take from a plain dump instead; here there
 * is no second source — the accessibility replace is the only path that can
 * empty a field in one edit, and refusing to start the helper would mean the
 * best clear only ever ran when some other tool happened to have warmed it.
 *
 * Bounded by {@link ATOMIC_CLEAR_BUDGET_MS}, and the loser of that race is
 * abandoned rather than cancelled: the registry has no cancel path, and the
 * initialisation it is already running is exactly what the next call wants to
 * find finished.
 */
async function startedDevtools(
  registry: Registry,
  device: DeviceInfo,
  deadline: number
): Promise<AndroidDevtoolsApi | undefined> {
  const ref = androidDevtoolsRef(device);
  const resolving = registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  // This is where a refused start is RECORDED, and it is deliberately not the
  // `catch` below: the race abandons the loser rather than cancelling it, so a
  // start that fails after the budget never reaches that `catch` at all — and
  // every failure ATOMIC_START_COOLDOWN_MS names is slower than the budget. The
  // handler also settles the abandoned rejection, which the race would leave for
  // nobody once the timer has won.
  resolving.catch(() => {
    atomicStartRefusedAt.set(device.id, Date.now());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolving,
      // An armed `setTimeout` holds the event loop open on its own, so the timer
      // is cleared even when the resolve wins — harmless in the long-lived
      // tool-server, but it delays the exit of any short-lived process that
      // imports this.
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replace the focused field's contents in ONE accessibility edit, or say why it
 * could not be done.
 *
 * This is the PREFERRED Android clear, and the two paths below it exist because
 * it is not always available. `adb shell input` cannot express "replace this
 * field's value": its clear is a select-all chord plus a delete, and the text is
 * a third invocation, so the field is observed EMPTY in between — measured on a
 * Pixel 3a (API 36) at ~250ms fixed plus ~89ms PER CHARACTER, because `input`
 * injects one KeyEvent pair per character and waits for the app to handle each.
 * `Friends` is ~850ms of wall clock with the app's main thread running seven
 * times inside it, which is the window an app's reaction to the empty field
 * lands in; the survivor was always a proper suffix of the request (see
 * `AndroidClearOptions.keepSelection`).
 *
 * `ACTION_SET_TEXT` is a single `TextView.setText(…, BufferType.EDITABLE, …)`,
 * so there is no intermediate state to race and no chord for a widget to
 * swallow — which is the OTHER hole it closes. A swallowed select-all is
 * invisible to `input` (the chord reports nothing and exits 0), so the injected
 * clear silently becomes a no-op reported as `cleared: true`; a Flutter
 * `TextField` does exactly this. Here the action answers, and the field is read
 * back afterwards, so an app that cannot do it says so instead of pretending.
 *
 * Every negative outcome is a REASON, never a throw. The helper being down, too
 * old, a widget that refuses, a field that cannot be read back — all of them
 * mean the same thing to the caller, which is that the injected path runs
 * instead. Throwing here would turn a device on which `keyboard` works today
 * into one on which it errors.
 *
 * `matched` is the bar, not `applied`. A widget can accept the action and do
 * nothing with it: Flutter's bridge returns true from `performSetText` and
 * forwards the value to the Dart side, which is free to ignore it. Only reading
 * the field back separates the two, and an unverified atomic write is worth less
 * than a fallback that reports honestly.
 */
async function tryAtomicClear(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason: AndroidClearSkipReason;
      applied: boolean;
      /** The budget expired on a start that is STILL RUNNING — see below. */
      startAbandoned?: true;
    }
> {
  const refusedAt = atomicStartRefusedAt.get(device.id);
  if (refusedAt !== undefined && Date.now() - refusedAt < ATOMIC_START_COOLDOWN_MS) {
    return { ok: false, reason: "helper_unavailable", applied: false };
  }
  // Bounds the START only — see ATOMIC_CLEAR_BUDGET_MS for why the RPCs below
  // keep the client's own timeout instead of sharing this deadline.
  const deadline = Date.now() + ATOMIC_CLEAR_BUDGET_MS;
  let devtools: AndroidDevtoolsApi | undefined;
  try {
    devtools = await startedDevtools(registry, device, deadline);
  } catch {
    // The service could not be created — no adb, the APK would not install, the
    // instrumentation never announced a port. All of them are "no helper here",
    // and all of them are worth not re-asking about on the next keystroke. The
    // mark itself is written by `startedDevtools`, which sees this rejection
    // whether or not it beat the budget.
    return { ok: false, reason: "helper_unavailable", applied: false };
  }
  // Not recorded: this is the budget expiring on a start that is still running.
  // Reported, though: the measurement below must not go on to await the very
  // init this gave up on.
  if (!devtools) {
    return { ok: false, reason: "helper_unavailable", applied: false, startAbandoned: true };
  }
  // Bookkeeping, not a release. The guard above already returned for a mark
  // inside its cooldown, so the only mark that can be here is one that has
  // EXPIRED — which gates nothing. Dropping it keeps the map to devices that
  // have actually failed recently, rather than to every device this process has
  // ever seen fail.
  atomicStartRefusedAt.delete(device.id);
  const rpcStartedAt = Date.now();
  try {
    // `ping` is the liveness check as well as the protocol one, which is why
    // there is no separate `isReady()` gate: that flag is set by the same
    // handshake the factory already completed before resolving, so the only
    // state it adds is "disposed since" — and a disposed client fails this round
    // trip anyway. One question, one answer, and no branch that can throw
    // outside this `catch`.
    //
    // A helper predating `setText` rejects the call as an unknown method. Asking
    // first keeps that off the error path — where it is indistinguishable from a
    // transport fault — and costs one cheap round trip.
    const { protocol } = await devtools.ping();
    if (!(Number.parseInt(protocol, 10) >= SET_TEXT_MIN_PROTOCOL)) {
      // `!(x >= n)` rather than `x < n` so a helper whose protocol string does
      // not parse (NaN) is treated as too old rather than as new enough.
      return { ok: false, reason: "helper_outdated", applied: false };
    }
    // `text ?? ""` is the clear itself: `{ clear: true }` alone asks for an
    // empty field, which is the same one edit with an empty value.
    const { applied, matched, reason } = await devtools.setText(params.text ?? "");
    if (matched) return { ok: true };
    // `applied` is carried, not dropped: it is the helper's own answer to
    // "is the value already in the field", and the note's doubling warning is
    // decided from it rather than from the reason's name — see
    // `androidClearNote`.
    //
    // A miss always carries a reason EXCEPT when the write landed and the
    // read-back simply disagreed. That is `value_mismatch`, not a refusal: the
    // widget took the action, so naming it `action_refused` would tell the
    // caller the opposite of what happened on the one shape this `??` exists
    // for.
    return {
      ok: false,
      reason: reason ?? (applied === true ? "value_mismatch" : "action_refused"),
      applied: applied === true,
    };
  } catch {
    // A severed socket, a helper that died between the readiness check and the
    // call, an RPC that timed out. The injected path is the answer to all of
    // them — but only the last one is worth a cooldown, and how long the leg
    // took is what tells them apart (see WEDGED_RPC_MS). A helper that is up and
    // silent is re-asked on every clear otherwise, at 5s or 15s a time, and
    // nothing else remembers it: the mark above was deleted when the service
    // resolved.
    if (Date.now() - rpcStartedAt >= WEDGED_RPC_MS) {
      atomicStartRefusedAt.set(device.id, Date.now());
    }
    return { ok: false, reason: "rpc_failed", applied: false };
  }
}

// Phones / tablets inject over `adb shell input` (text / keyevent), NOT the
// simulator-server's HID transport: the guest silently drops HID key events on
// AVDs created with `hw.keyboard = no` (routine for CI / headless), so the tool
// used to report success while typing nothing — issue #449. `adb input` lands
// regardless of `hw.keyboard`, on emulators (any config) and physical devices,
// and surfaces a non-zero exit as a throw. `device.id` is the adb serial.
function typeAndroidPhone(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  // Serialized per device, because the injected clear holds a SELECTION across
  // awaits: every leg is its own adb invocation, so between the select-all and
  // whatever consumes it the field is fully selected — the delete on a
  // clear-only call, and the caller's own text on a `{ clear, text }`, which is
  // now what replaces the selection (see `keepSelection`). A concurrent call
  // landing anywhere in there types over that selection. See
  // `serializePerDevice`, where the measurements are — 4 of 4 corrupt on API 36
  // with both calls reporting 200. The atomic path holds no selection, but it
  // shares the chain anyway: it can FALL BACK into the injected one, and a
  // second call must not arrive mid-fallback.
  return serializePerDevice(deviceChainKey(device.id), () => {
    // Checked HERE, as this call's turn comes round, so a request the client has
    // already abandoned does not spend the device's keyboard — it leaves the
    // chain immediately and the next waiter starts. `adb shell input` itself is
    // not cancellable, so this is the only point a hang-up is honoured.
    signal?.throwIfAborted();
    return runAndroidPhoneType(registry, device, params, signal);
  });
}

async function runAndroidPhoneType(
  registry: Registry,
  device: DeviceInfo,
  params: KeyboardParams,
  signal?: AbortSignal
): Promise<KeyboardResult> {
  let keysPressed = 0;
  // Validate the text and the key name BEFORE anything is injected, because
  // `clear` empties the field: a `{ clear, text: "café" }` or
  // `{ clear, key: "bogus" }` has to reject with the field still intact, not
  // emptied and then 400. Both checks are pure, and `injectAndroidText` re-runs
  // the text one, so this hoist exists purely to sit above the clear below.
  // Only one of the two can be set — the tool rejects `{ text, key }` above the
  // dispatch — so there is no tie between them to break.
  if (params.text) assertTypeableAndroidText(params.text);
  if (params.key) resolveAndroidNamedKeycode(params.key);

  // Tier 1 — one atomic accessibility edit, verified by reading the field back.
  //
  // Scoped to requests carrying `clear`, which are the ones whose contract is
  // already "replace the contents". A bare `{ text }` keeps injecting key
  // events, so caret-relative typing and an app's `onKeyPress` handlers are
  // untouched by this.
  const atomic = params.clear ? await tryAtomicClear(registry, device, params) : undefined;
  // The second place a hang-up is honoured. `adb shell input` is not
  // cancellable, so the injected clear below cannot be interrupted once it
  // starts — but the atomic attempt above can spend ATOMIC_CLEAR_BUDGET_MS plus
  // two RPC timeouts before reaching here, and every one of those seconds used
  // to be spent on a request the client had already dropped, holding this
  // device's keyboard against everything queued behind it.
  //
  // Checked only on the failing arm HERE because the succeeding one has nothing
  // left to skip at this point: there is nothing to save by throwing away a
  // clear that already worked. Its own `key` press is checked separately, below.
  //
  // This is NOT the "a rejected request never changes the field" guarantee the
  // validation at the top of this function keeps. Two of the reasons that land
  // here — `unverifiable` and `value_mismatch` — mean the widget ACCEPTED the
  // replace, so the field may already carry it. Stopping is still the better
  // of the two: continuing would put the fallback's text on top of that write
  // (the doubling the note warns about), and the caller is no longer listening
  // to be told either way.
  if (!atomic?.ok) signal?.throwIfAborted();
  if (atomic?.ok) {
    // `keys` counts what was asked to be ENTERED, never the clear (see the tool
    // description), so the accounting matches the injected path's even though no
    // key was pressed to get the text in.
    if (params.text) keysPressed += params.text.length;
    // The helper can set a field's text; it cannot press Enter on it. `key`
    // therefore still goes out over `adb input`, exactly as it would have.
    if (params.key) {
      // The clear stands, but the key press is a SEPARATE side effect and this
      // is the last moment it can be withheld. Without the check a cancelled
      // `{ clear: true, key: "enter" }` submitted the field when the helper was
      // present and did not when it was absent — same request, same hang-up,
      // opposite side effect, decided by a path the caller cannot see. Both
      // twins check in exactly this position (`simulator-server-keys.ts`,
      // `platforms/chromium.ts`).
      signal?.throwIfAborted();
      await injectAndroidNamedKey(device.id, params.key);
      keysPressed++;
    }
    return { typed: params.text ?? params.key ?? "", keys: keysPressed, cleared: true };
  }

  // Clear first: `keyboard { clear: true, text: "…" }` replaces a field's value
  // in one call.
  //
  // With text to follow, the clear stops at the select-all and the text replaces
  // the selection, so the two are ONE edit and the field is never observed empty
  // in between — see AndroidClearOptions.keepSelection for the corruption that
  // intermediate state caused. `params.text` is truthy-tested exactly as the
  // injection below is: an empty (or absent) `text` types nothing, so it would
  // leave a field that was asked to be cleared merely selected.
  const replacesSelection = params.clear === true && !!params.text;
  // What the clear actually DID, which is not the same as what was asked for: a
  // level without `input keycombination` backspaces the field empty whatever
  // `keepSelection` said. Reporting the failure below off the REQUEST instead
  // told a legacy-level caller its value survived selected when the backspace
  // run had just deleted it — the exact opposite of the state, and with it the
  // advice not to assume the field is empty.
  let outcome: AndroidClearOutcome | undefined;
  if (params.clear) {
    // No preferred reader when this call started the helper and gave up on it.
    // The reader's gate counts STARTING as live, so it would resolve the node
    // this call created and await the init the atomic attempt already abandoned
    // — a second wait, on top of the budget, for an answer that has already
    // failed to arrive. With no reader it dumps, which is exactly what ran
    // before the helper was consulted at all.
    outcome = await injectAndroidClear(device.id, {
      readHierarchy:
        atomic?.ok === false && atomic.startAbandoned
          ? undefined
          : devtoolsHierarchyReader(registry, device),
      secretText: params.secretText === true,
      keepSelection: replacesSelection,
      // The over-length refusal below is the one message that would otherwise
      // tell a caller "Nothing was modified" after the widget had ACCEPTED a
      // replace — the same fact the note's doubling warning is built on.
      atomicWriteApplied: atomic !== undefined && !atomic.ok && atomic.applied,
    });
  }
  if (params.text) {
    try {
      await injectAndroidText(device.id, params.text);
    } catch (cause) {
      // A selection the caller's text never replaced is not the state a bare
      // transport failure describes. `adbShell`'s own error is filed under
      // ANDROID_ADB_COMMAND_FAILED and says only that `input text …` failed, so
      // a caller reads it as "nothing happened" and retries against a field it
      // believes still holds its value — where the next character typed into it,
      // by anything, replaces the lot. Same rewrap, and the same reasoning, as
      // the interrupted delete in `injectAndroidClear`.
      if (!outcome?.keptSelection) throw cause;
      throw new FailureError(
        // Two states, because text containing a `%` is sent as more than one
        // `input text` (see `splitForVerbatimPercent`) and this catch cannot see
        // how many of them landed. Both are "not empty", which is the assumption
        // the caller has to be talked out of; the remedy is the same for either.
        `keyboard clear: the replacement text did not finish reaching the device, and the ` +
          `focused field was NOT emptied. Either nothing landed — the select-all survives, so ` +
          `it still holds its whole value with all of it SELECTED, and the next character ` +
          `typed into it replaces the lot — or part of the text landed and replaced that ` +
          `selection, leaving the field holding only that part. Read the field's actual ` +
          `contents before continuing; do not send a replacement that assumes it is empty.`,
        {
          error_code: FAILURE_CODES.KEYBOARD_CLEAR_INTERRUPTED,
          failure_stage: "keyboard_clear_replace_android",
          failure_area: "tool_server",
          error_kind: getFailureSignal(cause)?.error_kind ?? "subprocess",
        }
      );
    }
    // `injectAndroidText` (via `assertTypeableAndroidText`) has already rejected
    // any non-ASCII, so every character here is a single codepoint and a single
    // UTF-16 unit — `.length` is the codepoint count (matching the tv /
    // simulator-server backends) without a spread.
    keysPressed += params.text.length;
  }
  if (params.key) {
    // Same reasoning as the atomic arm's own key press: the clear and any text
    // are already on the device and cannot be taken back, but the submit still
    // can be withheld.
    signal?.throwIfAborted();
    await injectAndroidNamedKey(device.id, params.key);
    keysPressed++;
  }
  return {
    typed: params.text ?? params.key ?? "",
    keys: keysPressed,
    ...(params.clear ? { cleared: true } : {}),
    // Only when the verified path did not run, and only from WHICH path did —
    // never from anything it read off the field. See `androidClearNote`.
    ...(atomic && !atomic.ok && outcome
      ? {
          note: androidClearNote(atomic.reason, outcome, {
            applied: atomic.applied,
            // The same truthiness the injection above is gated on, so the note
            // claims a second write only where one was actually sent.
            fallbackText: !!params.text,
            // Set by the tool's own `execute`, and the same flag that skips the
            // after-typing screenshot: the closing advice must not send the
            // agent to read a box holding a credential.
            secret: params.secretText === true,
          }),
        }
      : {}),
  };
}

// An Android TV emulator classifies as platform "android" by serial shape, so
// this branch handles both phones/tablets (`adb input`) and Android TV
// (focus-driven typing → `adb input text`). TV is a `runtimeKind`, not a
// `platform`, so the kind is an async runtime probe.
export function makeAndroidImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, KeyboardParams, KeyboardResult> {
  return {
    // Both sub-paths shell out to `adb`: the `isAndroidTv` probe up front, then
    // `adb input` either way (TV via the focus daemon, phone via `input text` /
    // `input keyevent`). Declare it so `dispatchByPlatform` preflights adb and a
    // missing binary fails with the clean 424 install hint rather than surfacing
    // from deeper in the probe. Matches the android branch of `describe` and
    // `tv-remote`.
    requires: ["adb"],
    // `options` is forwarded, not dropped: it carries the framework abort
    // signal, and the phone path holds a per-device queue (see
    // `typeAndroidPhone`). The TV path stays outside the queue — it cannot
    // `clear`, so it holds no selection across awaits.
    handler: async (_services, params, device, options) =>
      (await isAndroidTv(device.id))
        ? typeTv(registry, device, params)
        : typeAndroidPhone(registry, device, params, options?.signal),
  };
}
