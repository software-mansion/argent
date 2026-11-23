/**
 * The request matcher of await-network-request: which records satisfy the
 * call's criteria, and which come closest when none does.
 */

/** The layers the wait reads, as network-capture-start names them. */
export type WaitLayer = "js" | "ios-native" | "android-native" | "macos-native" | "chromium";

/** A request as every layer gives it to the wait: the list fields, never a body. */
export interface WaitRecord {
  /** Opens in view-network-request-details. */
  id: string;
  layer: WaitLayer;
  method: string;
  /** The request's URL; on Chromium, the final URL after a redirect. */
  url: string;
  status?: number;
  /**
   * `headers`: the response arrived and its body has not ended. `lost`: argent
   * stopped seeing the request before it ended (a stop, a dropped agent
   * connection or the app's exit came first), so its outcome is unknown.
   */
  state: "pending" | "headers" | "complete" | "failed" | "lost";
  durationMs?: number;
  errorText?: string;
}

/**
 * A request as a layer read it. `startedAt` is when it started, in epoch
 * milliseconds of the device's clock, which every layer of a device shares:
 * it orders the near misses across layers, and stays out of the result.
 */
export interface LayerRecord extends WaitRecord {
  startedAt?: number;
}

function withoutStart({ startedAt: _, ...record }: LayerRecord): WaitRecord {
  return record;
}

type UrlMatch = "contains" | "equals" | "matches";
export type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
type Outcome = "complete" | "failed" | "any";

export interface RequestCriteria {
  url: string;
  urlMatch: UrlMatch;
  /** `url` compiled, for `matches`: at the first test, as each poll tests every record again. */
  regex?: RegExp;
  method?: string;
  status?: number | StatusClass;
  outcome: Outcome;
}

export type Criterion = "url" | "method" | "status" | "outcome";

export interface NearMiss extends WaitRecord {
  /** The criteria the request does not meet. */
  mismatch: Criterion[];
}

export const STATUS_CLASSES: readonly StatusClass[] = ["1xx", "2xx", "3xx", "4xx", "5xx"];

function urlMatches(criteria: RequestCriteria, url: string): boolean {
  switch (criteria.urlMatch) {
    case "equals":
      return url.toLowerCase() === criteria.url.toLowerCase();
    case "matches":
      return (criteria.regex ??= new RegExp(criteria.url)).test(url);
    default:
      return url.toLowerCase().includes(criteria.url.toLowerCase());
  }
}

function statusMatches(wanted: number | StatusClass, status: number | undefined): boolean {
  if (status === undefined) return false;
  if (typeof wanted === "number") return status === wanted;
  return Math.floor(status / 100) === Number(wanted[0]);
}

function outcomeMatches(outcome: Outcome, state: WaitRecord["state"]): boolean {
  if (outcome === "complete") return state === "complete";
  if (outcome === "failed") return state === "failed";
  return state === "complete" || state === "failed";
}

/** The criteria `record` fails, in the order the call names them; empty for a match. */
export function mismatches(criteria: RequestCriteria, record: WaitRecord): Criterion[] {
  const failed: Criterion[] = [];
  if (!urlMatches(criteria, record.url)) failed.push("url");
  if (
    criteria.method !== undefined &&
    record.method.toLowerCase() !== criteria.method.toLowerCase()
  ) {
    failed.push("method");
  }
  // A failed request has a status only when its response arrived before it failed.
  if (criteria.status !== undefined && !statusMatches(criteria.status, record.status)) {
    failed.push("status");
  }
  if (!outcomeMatches(criteria.outcome, record.state)) failed.push("outcome");
  return failed;
}

/** The first request, oldest first, that meets every criterion. */
export function firstMatch(
  criteria: RequestCriteria,
  records: readonly LayerRecord[]
): WaitRecord | undefined {
  const found = records.find((record) => mismatches(criteria, record).length === 0);
  return found && withoutStart(found);
}

const MAX_NEAR_MISSES = 3;

/** The same request as another layer recorded it, which also gives it the same mismatch. */
function sameRequest(a: WaitRecord, b: WaitRecord): boolean {
  return (
    a.layer !== b.layer &&
    a.method.toLowerCase() === b.method.toLowerCase() &&
    a.url === b.url &&
    a.status === b.status &&
    a.state === b.state
  );
}

/**
 * The requests that come closest: a matching URL first, then the fewest failed
 * criteria, then the newest by start, across layers. A request that the js
 * layer and a native layer both recorded is listed once. `records` is each
 * layer's list, oldest first.
 */
export function nearMisses(criteria: RequestCriteria, records: readonly LayerRecord[]): NearMiss[] {
  const ranked = records
    .map((record, index) => ({ record, mismatch: mismatches(criteria, record), index }))
    .sort(
      (a, b) =>
        Number(a.mismatch.includes("url")) - Number(b.mismatch.includes("url")) ||
        a.mismatch.length - b.mismatch.length ||
        // A record without a start counts as the oldest; NaN, when neither has one, falls through.
        (b.record.startedAt ?? -Infinity) - (a.record.startedAt ?? -Infinity) ||
        b.index - a.index
    );
  const misses: NearMiss[] = [];
  for (const { record, mismatch } of ranked) {
    if (misses.length === MAX_NEAR_MISSES) break;
    if (misses.some((miss) => sameRequest(miss, record))) continue;
    misses.push({ ...withoutStart(record), mismatch });
  }
  return misses;
}

/** URLs in the note are cut to this many characters. */
const NOTE_URL_CHARS = 120;

function shortUrl(url: string): string {
  return url.length > NOTE_URL_CHARS ? `${url.slice(0, NOTE_URL_CHARS)}...` : url;
}

/** What the call asked for, in a few words: `POST, URL containing "/v1/login", status 2xx, complete`. */
export function describeCriteria(criteria: RequestCriteria): string {
  const url =
    criteria.urlMatch === "matches"
      ? `URL matching the regular expression "${shortUrl(criteria.url)}"`
      : `URL ${criteria.urlMatch === "equals" ? "equal to" : "containing"} "${shortUrl(criteria.url)}"`;
  return [
    criteria.method ? criteria.method.toUpperCase() : undefined,
    url,
    criteria.status !== undefined ? `status ${criteria.status}` : undefined,
    criteria.outcome === "any" ? "complete or failed" : criteria.outcome,
  ]
    .filter(Boolean)
    .join(", ");
}

/** One request in short form: `GET http://.../json 500 complete (mismatch: status)`. */
export function describeRecord(record: WaitRecord | NearMiss): string {
  const parts = [
    `${record.method || "?"} ${shortUrl(record.url)}`,
    record.status !== undefined ? String(record.status) : undefined,
    record.state,
    record.errorText ? `"${shortUrl(record.errorText)}"` : undefined,
    `[${record.layer} ${record.id}]`,
  ];
  const mismatch = "mismatch" in record ? ` (mismatch: ${record.mismatch.join(", ")})` : "";
  return `${parts.filter(Boolean).join(" ")}${mismatch}`;
}
