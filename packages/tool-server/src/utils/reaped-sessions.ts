/**
 * Process-global record of capture sessions a teardown reaped while they still
 * held data nobody had retrieved.
 *
 * `stop-all-simulator-servers` disposes every device-owned service, including
 * those that hold captured output. Disposing them is deliberate: each owns a
 * spawned process or an open fd that must not outlive the session.
 *
 * What is not deliberate is what the owner is then told. `Registry._teardown`
 * nulls the node's instance, so the next tool call resolves a FRESH service
 * indistinguishable from one that never ran, and the stop tools answer "no
 * active session, call start first" for a capture that did run and whose output
 * may still be on disk. It reads as "you never started one", the one thing that
 * is certainly false.
 *
 * So the disposer leaves a breadcrumb here and the tool that would otherwise
 * report absence reports the teardown instead. Module-global for the same
 * reason as `screen-recording-reminder`: it has to outlive the service instance
 * it describes, which is exactly what teardown destroys.
 *
 * Entries are CONSUMED by the read ({@link takeReapedSession}) — the breadcrumb
 * explains one confusing answer, once. Leaving it would make a genuine later
 * "you never started a recording" blame a teardown from an hour ago.
 *
 * One entry can also own a file: this store unlinks the log a {@link
 * ReapedSession.keptAt} names when a later event on the same device supersedes
 * the entry AND kept a file of its own — a second crash, never a teardown,
 * which keeps none. So it is a lifetime owner, not only a message board. Read
 * that field's doc first.
 */

import * as fs from "node:fs";
import { classifyDevice } from "./device-info";

/** A log file a replaced record left behind, with the event that kept it. */
interface KeptFile {
  file: string;
  event: number;
}

/** Which session kind was reaped; scopes the key so two kinds can't collide. */
type ReapedSessionKind = "screen-recording" | "native-profiler" | "js-runtime-debugger";

/**
 * What ended the session: `runtime-death` is a closed socket no `dispose()`
 * accounts for, `teardown` a `dispose()` whose caller the disposer cannot see.
 *
 * The socket is all the disposer reads, so a Chromium dispose landing inside a
 * tab switch — the client briefly between sockets — is filed as a death.
 */
type ReapedSessionCause = "teardown" | "runtime-death";

interface ReapedSession {
  kind: ReapedSessionKind;
  deviceId: string;
  /** Ties the copies filed under one device's several ids into one teardown. */
  event: number;
  /** When the teardown ran, for "…N seconds ago" phrasing. */
  atMs: number;
  /**
   * Earlier events this one left with no key to report under, so nothing else
   * will ever mention what they captured. Counts the chain, not the step: an
   * unread crash loop replaces a replacer every time round.
   */
  superseded?: number;
  /**
   * …and how many of their log files were unlinked with them. One write takes
   * at most one — no two live records share a filed id set — but a chain takes
   * once per round, and this count is the only thing that carries that forward:
   * the record holding it is itself replaced next time round.
   */
  supersededFilesTaken?: number;
  /**
   * …and the logs the rest kept, which nothing but this field still names.
   * Paths, not a flag: the read hands them out, and the sweep may have taken
   * them first. Each carries the event that kept it, because the read names
   * only the newest few and a file outlives the record that kept it: a chain
   * hands its files on to whatever replaces it, so the carrier's own age says
   * nothing about theirs.
   */
  supersededFilesLeft?: KeptFile[];
  /** Keys this event was filed under; later writes narrow what it answers to. */
  filedKeys: readonly string[];
  /**
   * The id the runtime itself gave this device — Metro's `logicalDeviceId`, or
   * on Chromium the device id, which is the same thing there. Absent for a
   * legacy inspector (Vega, RN 0.72), which reports none.
   *
   * The file reclaim needs it: see the rule in {@link recordReapedSession}.
   */
  logicalId?: string;
  cause: ReapedSessionCause;
  /**
   * What survived, as a ready-to-read clause (e.g. naming a salvaged file), or
   * undefined when nothing did. Built by the disposer, which is the only place
   * that still knows.
   */
  salvage?: string;
  /**
   * A file this store may DELETE. Held apart from {@link salvage} so the read
   * can check it survived the day-old sweep. Set it only where the breadcrumb
   * owns the file's lifetime — a recording or trace the user keeps does not.
   */
  keptAt?: string;
}

const reaped = new Map<string, ReapedSession>();
let nextEvent = 1;

/** How many of a chain's surviving log files the note names before counting. */
const MAX_NAMED_FILES = 3;

function key(kind: ReapedSessionKind, deviceId: string, scope?: string): string {
  return `${kind}:${scope ?? ""}:${deviceId.toLowerCase()}`;
}

/**
 * Note that `kind`'s session for `deviceId` was disposed with data unretrieved.
 *
 * Call ONLY when there was something to lose: recording an idle session's
 * routine dispose would make the next honest "no active session" answer claim a
 * teardown destroyed something.
 *
 * Pass every id the device answers to — a debugger session is readable back
 * under the id the caller connected with OR the `logicalDeviceId` Metro echoed,
 * and only the disposer knows both. They file one event, so consuming either
 * spends all of them.
 *
 * `cause` defaults to `"teardown"`, all a disposer can say when it knows only
 * that `dispose()` ran; pass `"runtime-death"` where it can tell the runtime
 * went out from under the session, and `keptAt` where it left a file to read.
 *
 * `logicalId` is the id the runtime itself gave the device, and is what lets a
 * later event reclaim the file this one kept. Pass it wherever there is one;
 * omit it for a legacy inspector, which reports none, and its files then wait
 * for the day-old sweep rather than being taken on ids alone.
 *
 * `scope` tells apart two sessions of one kind on one device, and readers must
 * pass the same one. A Metro-backed debugger is per port, each with its own log
 * file, so without the port a session ending on 8082 supersedes the crash
 * breadcrumb from 8081 — and reclaims the file it named, if 8082 crashed too. Omit it where a device
 * holds at most one session of the kind (a recording, a profiler trace), and on
 * Chromium, whose port is already inside the device id.
 */
export function recordReapedSession(
  kind: ReapedSessionKind,
  deviceIds: string | string[],
  salvage?: string,
  opts: {
    cause?: ReapedSessionCause;
    keptAt?: string;
    scope?: string;
    logicalId?: string;
  } = {}
): void {
  const event = nextEvent++;
  const ids = new Set(typeof deviceIds === "string" ? [deviceIds] : deviceIds);
  const keys = new Set([...ids].map((id) => key(kind, id, opts.scope)));
  // Read before the write below overwrites any of it: every event this one lands
  // on top of, with every key it holds — the ones taken here and the ones left.
  const collided = new Set<number>();
  for (const k of keys) {
    const previous = reaped.get(k);
    if (previous) collided.add(previous.event);
  }
  const displaced = new Map<
    number,
    {
      keys: Set<string>;
      filedKeys: readonly string[];
      logicalId?: string;
      keptAt?: string;
      carried: number;
      carriedTaken: number;
      carriedFiles: readonly KeptFile[];
    }
  >();
  for (const [k, entry] of reaped) {
    if (!collided.has(entry.event)) continue;
    const seen = displaced.get(entry.event);
    if (seen) seen.keys.add(k);
    else
      displaced.set(entry.event, {
        keys: new Set([k]),
        filedKeys: entry.filedKeys,
        logicalId: entry.logicalId,
        keptAt: entry.keptAt,
        // What it was already answering for; see {@link ReapedSession.superseded}.
        carried: entry.superseded ?? 0,
        carriedTaken: entry.supersededFilesTaken ?? 0,
        carriedFiles: entry.supersededFilesLeft ?? [],
      });
  }
  const filedNow: ReapedSession[] = [];
  const filedKeys = [...keys];
  for (const deviceId of ids) {
    const entry: ReapedSession = {
      kind,
      deviceId,
      event,
      atMs: Date.now(),
      cause: opts.cause ?? "teardown",
      filedKeys,
    };
    if (salvage) entry.salvage = salvage;
    if (opts.keptAt) entry.keptAt = opts.keptAt;
    if (opts.logicalId) entry.logicalId = opts.logicalId;
    reaped.set(key(kind, deviceId, opts.scope), entry);
    filedNow.push(entry);
  }
  const orphanedFiles = new Map<string, number>();
  // Anything still in the store is unread — a read deletes every copy — so
  // replacing one is a second teardown arriving before the first was reported.
  let replacedUnread = 0;
  // The replaced records' files this write does not take. Nothing else records
  // them, so this field is the only thing that can still name them.
  // Keyed by path so a file reached twice is recorded once, and holding the
  // event that KEPT it: the read names only the newest few, and neither the
  // store's order nor the carrier's age gives that. `displaced` follows the
  // store's key order, which is where each key was first written; and a chain
  // hands its files on, so a late teardown can carry an ancient log.
  const filesLeftUnnamed = new Map<string, number>();
  // Takes this write inherits from the records it is replacing, for the same
  // reason `carried` exists: the record that knew about them is going away.
  let takenCarried = 0;
  for (const [event, previous] of displaced) {
    // An event still holding a key this one did not take goes on answering under
    // it, so nothing of its has gone unreported.
    if ([...previous.keys].some((k) => !keys.has(k))) continue;
    replacedUnread += 1 + previous.carried;
    takenCarried += previous.carriedTaken;
    // Its FILE goes with it only where this event answers to exactly the same
    // ids. Nothing weaker proves one device: `selectTarget`'s one-device
    // fallback mints a stranger's session on a crashed device's logicalDeviceId,
    // so a set this one merely covers is equally that stranger, and taking the
    // file there takes the log kept for the device that actually crashed.
    //
    // It also needs a file of this event's own, which bounds an unread crash
    // LOOP to one file per device. A teardown between two crashes keeps none of
    // its own, so it replaces the record without touching the log: the reader
    // gets the path from `supersededFilesLeft` instead.
    //
    // Never this event's own path: the unlink runs after the write above, so a
    // file recorded twice would be taken from the answer advertising it.
    //
    // Against the ids it was FILED under, not the ones it still answers to: a
    // write that took one key off a two-id record leaves it answering to one,
    // and a narrower write after that would otherwise read as the exact match
    // this rule is the whole guard against.
    //
    // And both events have to name the same runtime-assigned id. Matching key
    // sets prove one device only while a device files two keys; a legacy
    // inspector (Vega, RN 0.72) reports no `logicalDeviceId`, so its disposer
    // files the connect id alone and the fallback's stranger — minted on that
    // same id, on the one device Metro had left — files a set identical to the
    // owner's. `logicalId` is the id the runtime gave, so a stranger carries a
    // different one or, being legacy itself, none; either way the owner's log
    // waits for the day-old sweep rather than being taken from it. The cost is
    // that a legacy crash LOOP keeps a file per round, the same treatment a
    // loop with a teardown between rounds already gets.
    const sameIds =
      previous.logicalId !== undefined &&
      previous.logicalId === opts.logicalId &&
      previous.filedKeys.length === keys.size &&
      previous.filedKeys.every((k) => keys.has(k));
    const keptAt = previous.keptAt;
    if (keptAt !== undefined && keptAt !== opts.keptAt) {
      if (opts.keptAt !== undefined && sameIds) orphanedFiles.set(keptAt, event);
      else filesLeftUnnamed.set(keptAt, event);
    }
    for (const carried of previous.carriedFiles) filesLeftUnnamed.set(carried.file, carried.event);
  }
  // Before the flags below, so they answer for what is on disk rather than what
  // was intended: an unlink the filesystem refuses leaves the file there for the
  // clause to name, which is a leave. One already gone is a take either way.
  let takenNow = 0;
  for (const [file, event] of orphanedFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already gone, or never ours
    }
    if (fs.existsSync(file)) filesLeftUnnamed.set(file, event);
    else takenNow += 1;
  }
  if (replacedUnread > 0) {
    const left = [...filesLeftUnnamed].map(([file, event]) => ({ file, event }));
    const taken = takenCarried + takenNow;
    for (const entry of filedNow) {
      entry.superseded = replacedUnread;
      if (taken > 0) entry.supersededFilesTaken = taken;
      if (left.length > 0) entry.supersededFilesLeft = left;
    }
  }
}

/**
 * Read and consume the breadcrumb for `kind`/`deviceId`, if there is one.
 *
 * Consumes every copy of the same teardown, not just the one that matched. A
 * reader knows only the id it was called with, so a per-key delete would leave
 * a twin behind to explain a later, unrelated read — and to reclaim, on the
 * next crash under the same ids, the very file this answer just named.
 */
export function takeReapedSession(
  kind: ReapedSessionKind,
  deviceId: string,
  scope?: string
): ReapedSession | undefined {
  const entry = reaped.get(key(kind, deviceId, scope));
  if (!entry) return undefined;
  for (const [k, sibling] of reaped) {
    if (sibling.event === entry.event) reaped.delete(k);
  }
  return entry;
}

/**
 * The clause for the events this one replaced before anything read them.
 *
 * Names neither what ended them, whose device they were, nor what they held: a
 * teardown replaces a crash as readily as the reverse, `selectTarget`'s
 * one-device fallback can file a stranger's session under this id, and all three
 * kinds reach this clause. Only three things are certain — they held output,
 * nothing read it, and no id reaches their record now. Their log files are named
 * anyway: the exact-id-set rule above guards the DELETION of a stranger's file,
 * and a path costs a reader one grep to reject where a directory costs a listing.
 */
function describeReplacedRecords(entry: ReapedSession): string {
  const count = entry.superseded ?? 0;
  if (count === 0) return "";
  const taken = entry.supersededFilesTaken ?? 0;
  const subject = count === 1 ? "An earlier session" : `${count} earlier sessions`;
  const they = count === 1 ? "it" : "they";
  // Naming a log file is the debugger's alone: `keptAt` comes from the two
  // debugger blueprints and nothing else, so a kind that starts keeping files
  // needs wording of its own here. Existence is re-checked at read time because
  // a breadcrumb nobody read outlives the day-old sweep that reclaims them.
  const left = (entry.supersededFilesLeft ?? [])
    // Newest kept first, since the cap below drops the rest and the round that
    // just died is the one a reader came for. By the event that KEPT each file,
    // not the record carrying it: a chain hands its files on, so a late
    // teardown carries logs far older than itself.
    .slice()
    .sort((a, b) => b.event - a.event)
    .map(({ file }) => file)
    .filter((file) => fs.existsSync(file));
  // The paths, not the directory holding them. A log file's name carries a port
  // and a clock and nothing that says whose session it is, and ~/.argent/tmp
  // holds every device's, every port's and every tool-server's, so a reader sent
  // at the listing has to open each one to find the session's own — and the
  // salvage clause above already hands out an absolute path under exactly the
  // same conditions.
  //
  // Capped because the list grows by one path per unread supersession and this
  // string is a tool result: a crash loop with a teardown between the rounds
  // keeps every file, since neither event can reclaim across the one that kept
  // none. The rest are counted and not located: the directory is the locator
  // the paragraph above rejects, and a name in it carries no device or session,
  // so pointing a reader at it is the non-answer naming paths exists to avoid.
  const shown = left.slice(0, MAX_NAMED_FILES);
  const unnamed = left.length - shown.length;
  const where =
    ` still on disk, at ${shown.join(", ")}` +
    (unnamed > 0 ? `, and ${unnamed} more this note does not name.` : `.`);
  const file =
    taken > 0
      ? // How many, because a chain takes once per round and only this count
        // survives the record that knew about the round before. WHICH of them
        // lost a file stays unsayable: a write replaces every record its ids
        // reach, and the take falls on whichever was filed under exactly this id
        // set — as readily the oldest as the newest. An order here would send a
        // reader after the one file that is not there.
        (taken === 1
          ? ` The log file ${count === 1 ? "it" : "one of them"} kept went with it.`
          : ` The log files ${taken === count ? `all ${count}` : taken} of them kept went with ` +
            `them.`) + (left.length > 0 ? ` Anything the others left is${where}` : ``)
      : left.length > 0
        ? ` Any log file ${they} left is${where}`
        : ``;
  return (
    ` ${subject} that answered here ended holding output nobody read, and this event ` +
    `replaced what ${they} filed, so what ${they} captured is reported nowhere.` +
    file
  );
}

/**
 * The sentence a tool shows in place of "no active session", or attaches as a
 * `note` beside an answer a reaped session would otherwise make misleading.
 * Names what happened, says it is not necessarily this agent's own doing (one
 * tool-server serves every agent), and points at whatever survived.
 *
 * Neither cause names a culprit. A disposer cannot see who triggered a
 * `teardown` — `Registry._teardown` calls `dispose()` with no caller — so the
 * message names the family; a `runtime-death` is a dropped socket, which a
 * crash, a force-quit, a `restart-app` and Metro evicting this debugger for a
 * new one all produce alike. Which of those an agent can act on is
 * platform-specific, so a Chromium session gets the sentence in its own terms.
 */
export function describeReapedSession(entry: ReapedSession, what: string): string {
  const secondsAgo = Math.max(0, Math.round((Date.now() - entry.atMs) / 1000));
  const isChromium = classifyDevice(entry.deviceId) === "chromium";
  const runtimeDeath = isChromium
    ? `its debugger connection dropped instead of being closed — the page went away (a crash, ` +
      `a tab or window closing, the browser quitting), its CDP endpoint stopped being ` +
      `reachable, or a teardown landed while a tab switch had the client between sockets — ` +
      `which ends the session the same way a teardown does. Nothing here separates the ` +
      `three: the close reason that would is not kept.`
    : `its debugger connection dropped instead of being closed — the app went away (a crash, ` +
      `a force-quit, a restart-app), the runtime stopped being reachable (Metro restarted, ` +
      `a device transport dropped), or another debugger attached and Metro closed this one, ` +
      `its inspector proxy allowing one per device and this one having lost the race — which ` +
      `ends the session the same way a teardown does. Nothing here separates the three: the ` +
      `close reason that would is not kept, and a later debugger-status answers for the ` +
      `runtime as it is by then, not for the one that died.`;
  // Only a debugger session has another tool that can have disposed it, and not
  // on every platform: a Chromium one goes with the `ChromiumCdp` that
  // `stop-simulator-server` and an Electron-reclaiming `flow-run` both reap, and
  // an Apple or Android one is cleared by `react-profiler-start`. A Vega session
  // has neither, and a recording and a trace declare no dependency to cascade.
  const otherReacher =
    entry.kind !== "js-runtime-debugger"
      ? undefined
      : isChromium
        ? `a stop-simulator-server, or a flow-run reclaiming an Electron app it booted, either ` +
          `of which cascades into the debugger through the Chromium CDP session it reaps`
        : classifyDevice(entry.deviceId) === "vega"
          ? undefined
          : `a react-profiler-start, which disposes the debugger session along with its own ` +
            `whenever either is in a state it cannot reuse`;
  const why =
    entry.cause === "runtime-death"
      ? runtimeDeath
      : `by a stop-all-simulator-servers, which reaps every service a device owns` +
        (otherReacher ? `, or by ${otherReacher}` : ``) +
        `. One tool-server serves every agent using this argent install, so this may have been ` +
        `another agent rather than your own call.`;
  // The salvage clause was written when the file was there; a breadcrumb nobody
  // read can outlive it, so correct the promise rather than name a reclaimed path.
  const salvage =
    entry.keptAt && !fs.existsSync(entry.keptAt)
      ? `The log file it left at ${entry.keptAt} has since been reclaimed — a debugger ` +
        `session sweeps one a day old — so those entries are gone.`
      : entry.salvage;
  const earlier = describeReplacedRecords(entry);
  return (
    `The ${what} for device ${entry.deviceId} was torn down ${secondsAgo}s ago — ${why} ` +
    `It was not a session that never started.` +
    (salvage ? ` ${salvage}` : "") +
    earlier
  );
}

/**
 * The {@link ReapedSession.salvage} clause for a debugger session torn down
 * while it still held console history nobody had read.
 *
 * Pass `keptAt` — the log file's path — when the teardown left the file on disk,
 * which a runtime death does whenever the writer had one; omit it when there is
 * nothing to read. The clause settles only whether the old entries are still
 * readable somewhere: why the session ended is the {@link ReapedSessionCause}
 * clause's job.
 */
export function describeLostHistory(captured: number, keptAt?: string): string {
  const entries = `${captured} captured console ${captured === 1 ? "entry" : "entries"}`;
  if (keptAt) {
    return `The log file is kept at ${keptAt} — grep that file for the ${entries} it holds.`;
  }
  return `The ${entries} went with it — no log file was left behind.`;
}

/** Test-only: drop all breadcrumbs so cases don't leak across tests. */
export function __resetReapedSessionsForTesting(): void {
  reaped.clear();
  nextEvent = 1;
}
