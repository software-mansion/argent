import { z } from "zod";
import {
  FAILURE_CODES,
  FailureError,
  type Registry,
  type ToolContext,
  type ToolDefinition,
} from "@argent/registry";
import { resolveDevice, parseMacosAppBundleId } from "../../utils/device-info";
import { assertSupported } from "../../utils/capability";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import { SECRET_PLACEHOLDER_MARKER } from "../../utils/secrets";
import { settleWithin, sleepOrAbort } from "../../utils/timing";
import {
  AWAIT_NETWORK_REQUEST_TOOL_ID,
  darkTailToleranceMs,
  type UnmetWaitCause,
} from "../../utils/wait-result";
import { CAPTURE_CAPABILITY } from "../network/network-capture";
import { assertMacosAppBundle } from "../native-devtools/macos-view-hierarchy";
import { markedLayers, type LayerRead, type MarkedLayer } from "./layers";
import {
  STATUS_CLASSES,
  describeCriteria,
  describeRecord,
  firstMatch,
  nearMisses,
  type NearMiss,
  type RequestCriteria,
  type WaitLayer,
  type WaitRecord,
} from "./match";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 400;
/** A read of the JS layer waits on the app's JS thread; it gets at least this long per poll. */
const MIN_JS_READ_MS = 1_000;
const zodSchema = z
  .object({
    udid: z
      .string()
      .min(1)
      .describe(
        "Device ID passed as udid to network-capture-start. The wait reuses its Metro target."
      ),
    bundleId: z
      .string()
      .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
      .describe(
        "The bundleId used for network-capture-start. On Chromium, use a valid placeholder such as argent.capture."
      ),
    url: z
      .string()
      .min(1)
      .describe(
        "URL text or a pattern. Match a part with no secrets. The result includes the full URL and secret placeholders are rejected."
      ),
    urlMatch: z
      .enum(["contains", "equals", "matches"])
      .optional()
      .describe(
        "contains (default) and equals ignore case. matches uses a case-sensitive JavaScript regular expression with no implicit anchors."
      ),
    method: z.string().min(1).optional().describe("HTTP method, matched without regard to case."),
    status: z
      .union([
        z.enum(STATUS_CLASSES as [string, ...string[]]),
        z.coerce.number().int().min(100).max(599),
      ])
      .optional()
      .describe(
        'Exact HTTP status or a class such as "2xx". Failed requests can match if they received response headers.'
      ),
    outcome: z
      .enum(["complete", "failed", "any"])
      .optional()
      .describe(
        "complete (default) accepts a finished response, including HTTP errors. failed accepts a request error. any accepts either."
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe(`Wait limit in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`),
    pollIntervalMs: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .optional()
      .describe(
        `Interval between capture reads in milliseconds. Default ${DEFAULT_POLL_INTERVAL_MS}.`
      ),
  })
  .strict()
  .superRefine((params, ctx) => {
    if (params.url.includes(SECRET_PLACEHOLDER_MARKER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message:
          "url takes no {{secret:...}} placeholder: a matcher never resolves secrets, and the match is returned in the result. Match on another part of the URL.",
      });
    }
    if (params.urlMatch === "matches") {
      try {
        new RegExp(params.url);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: `url is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  });

type Params = z.infer<typeof zodSchema>;

interface LayerSummary {
  layer: WaitLayer;
  armed: boolean;
  /** Read in this call at least once. */
  readable: boolean;
  stopped?: true;
  /** The requests since the start that the last read of the layer saw. */
  requests: number;
  note?: string;
}

interface WaitResult {
  success: boolean;
  elapsed: number;
  /** The first request since the start that meets every criterion. */
  match?: WaitRecord;
  note?: string;
  /** Why a wait that did not hold came back success: false; only `unmet` is a verdict. */
  cause?: UnmetWaitCause;
  /** The closest requests since the start, on a wait that did not hold. */
  nearMisses?: NearMiss[];
  /** Each layer the start marked, on a wait that did not hold. */
  layers?: LayerSummary[];
}

const CANCELLED_NOTE = "the wait was cancelled before a request matched";

function criteriaOf(params: Params): RequestCriteria {
  return {
    url: params.url,
    urlMatch: params.urlMatch ?? "contains",
    ...(params.method !== undefined ? { method: params.method } : {}),
    ...(params.status !== undefined ? { status: params.status as RequestCriteria["status"] } : {}),
    outcome: params.outcome ?? "complete",
  };
}

function notStartedError(params: Params): FailureError {
  return new FailureError(
    `Network capture is not started for ${params.bundleId} on ${params.udid}, so no request can be waited for. ` +
      `Call network-capture-start for ${params.bundleId}, repeat the action that sends the request, then call await-network-request. ` +
      "stop-all-simulator-servers, a stop of the device's services and a tool-server restart also end a capture.",
    {
      error_code: FAILURE_CODES.NETWORK_CAPTURE_NOT_STARTED,
      failure_stage: "await_network_request_marks",
      failure_area: "tool_server",
      error_kind: "not_found",
    }
  );
}

function isOpen(record: WaitRecord): boolean {
  return record.state === "pending" || record.state === "headers";
}

/** A read and when it settled. */
type TimedRead = LayerRead & { at: number };

export function createAwaitNetworkRequestTool(
  registry: Registry
): ToolDefinition<Params, WaitResult> {
  return {
    // A literal, so scripts/extract-tools.mjs finds the description it scores.
    id: "await-network-request",
    description: `Check whether a request finished in the latest capture window. Call network-capture-start before the action. Call this tool after triggering the request, then stop capture when you are done. On Chromium, match the final URL and method after redirects. Other layers use the URL the app requested. Physical iPhones and Vega are unsupported.
Returns the match or diagnostic details. Use match.id with view-network-request-details. A miss only means no captured request matched. Check cause and nearMisses. If capture is unreadable, follow the layer notes before repeating the action. An active JS window can restore recording after a disconnect. Requests sent before it reconnects can be missing.
Fails with NETWORK_CAPTURE_NOT_STARTED if there is no usable capture window. Start capture and repeat the action. A result with success false fails an e2e step and stops a run-sequence.`,
    zodSchema,
    searchHint:
      "wait await network request http api call fetch xhr response status url match after capture start e2e assert",
    readOnly: true,
    longRunning: true,
    capability: CAPTURE_CAPABILITY,
    interaction: {
      startedMsg: ({ params }) => `Waiting for a request to ${params.url}`,
      completedMsg: ({ params, result }) =>
        result.success && result.match
          ? `Request matched: ${result.match.method} ${result.match.url}${result.match.status !== undefined ? ` ${result.match.status}` : ""}`
          : `No request to ${params.url} matched (${result.cause ?? "unmet"})`,
      failedMsg: ({ failureSignal }) =>
        `Failed while waiting for a network request: ${failureSignal.error_code}`,
    },
    // Each layer looks its service up itself, so the wait creates no native service.
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const signal = ctx?.signal;
      const device = resolveDevice(params.udid);
      // Only the HTTP gate checks the capability, and an e2e `tool:` step does not pass it.
      assertSupported(AWAIT_NETWORK_REQUEST_TOOL_ID, CAPTURE_CAPABILITY, device);
      // A Mac app id names one app, whose layers the wait reads whatever bundleId says.
      if (device.platform === "macos") {
        assertMacosAppBundle(parseMacosAppBundleId(device.id) ?? device.id, params.bundleId);
      }
      const layers = await markedLayers(registry, device, params.bundleId);
      if (layers.length === 0) throw notStartedError(params);

      const criteria = criteriaOf(params);
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const start = Date.now();
      const deadline = start + timeoutMs;
      const elapsed = () => Date.now() - start;

      const native = layers.filter((layer) => layer.layer !== "js");
      const js = layers.find((layer) => layer.layer === "js");
      /** The latest read of each layer in this call, readable or not. */
      const latest = new Map<WaitLayer, TimedRead>();
      /** The latest read of each layer that reached its records. */
      const latestReadable = new Map<WaitLayer, TimedRead>();
      /** When an armed native layer, and the armed JS layer, was last read. */
      let lastArmedNativeAt: number | undefined;
      let lastArmedJsAt: number | undefined;
      /** A JS read gets this long, and comes at most this long plus a poll after the last. */
      const jsBound = Math.max(pollIntervalMs, MIN_JS_READ_MS);
      /** Every note a read gave in this call, by layer: a later read may not repeat one. */
      const notesSeen = new Map<WaitLayer, Set<string>>();
      const keep = (read: TimedRead): void => {
        latest.set(read.layer, read);
        if (read.note) {
          const seen = notesSeen.get(read.layer) ?? new Set<string>();
          notesSeen.set(read.layer, seen.add(read.note));
        }
        if (!read.readable) return;
        latestReadable.set(read.layer, read);
        if (!read.armed) return;
        if (read.layer === "js") lastArmedJsAt = read.at;
        else lastArmedNativeAt = Math.max(lastArmedNativeAt ?? 0, read.at);
      };
      // One read of the JS layer at a time: a runtime that does not answer
      // within its bound keeps its read out, and the next poll waits on it again.
      let jsRead: Promise<TimedRead> | undefined;
      const readJs = (layer: MarkedLayer, budgetMs: number): Promise<TimedRead> => {
        if (jsRead) return jsRead;
        const read = layer
          .read(budgetMs)
          .then((answer) => ({ ...answer, at: Date.now() }))
          .finally(() => {
            if (jsRead === read) jsRead = undefined;
          });
        jsRead = read;
        return read;
      };

      const success = (match: WaitRecord): WaitResult => {
        // What the reads in this call said of each layer, as a reload that left
        // requests out, so that the match may not be the first request.
        const notes = [...notesSeen].flatMap(([layer, seen]) =>
          [...seen].map((note) => `${layer}: ${note}`)
        );
        return {
          success: true,
          elapsed: elapsed(),
          match,
          ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
        };
      };

      for (;;) {
        const atDeadline = Date.now() >= deadline;
        if (signal?.aborted) {
          return { success: false, elapsed: elapsed(), note: CANCELLED_NOTE, cause: "cancelled" };
        }
        // The native layers are read in memory, so they come first and cost the app nothing.
        const reads: TimedRead[] = [];
        for (const layer of native) {
          const read = { ...(await layer.read(0)), at: Date.now() };
          keep(read);
          reads.push(read);
          const match = firstMatch(criteria, read.records);
          if (match) return success(match);
        }
        const remaining = deadline - Date.now();
        // The pass at the deadline reads only the native layers: a JS read there gets no time to answer.
        if (js && (remaining > 0 || !latest.has("js"))) {
          const bound = Math.min(jsBound, Math.max(1, remaining));
          const settled = await settleWithin(readJs(js, bound), bound, signal);
          if (settled.type === "aborted") {
            return { success: false, elapsed: elapsed(), note: CANCELLED_NOTE, cause: "cancelled" };
          }
          if (settled.type === "value") {
            keep(settled.value);
            reads.push(settled.value);
            const match = firstMatch(criteria, settled.value.records);
            if (match) return success(match);
          } else if (settled.type === "timeout" && bound < jsBound && latest.has("js")) {
            // The deadline cut the read short, which says nothing of the runtime: the layer keeps its last read.
          } else {
            const note =
              settled.type === "timeout"
                ? `the app's JS runtime did not answer within ${bound} ms`
                : `the read of the app's JS runtime failed: ${settled.error}`;
            const read: TimedRead = {
              layer: "js",
              readable: false,
              armed: false,
              stopped: latest.get("js")?.stopped ?? false,
              records: [],
              note,
              at: Date.now(),
            };
            keep(read);
            reads.push(read);
          }
        }
        // Nothing new can arrive once every marked layer is stopped and none holds a request in flight.
        if (
          reads.length === layers.length &&
          reads.every((read) => read.readable && read.stopped && !read.records.some(isOpen))
        ) {
          return timedOut("unmet", true);
        }
        if (atDeadline) break;
        // A JS read that ran into the deadline: the native layers get one more read at it.
        if (Date.now() >= deadline) continue;
        const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
        if (!(await sleepOrAbort(sleepMs, signal))) {
          return { success: false, elapsed: elapsed(), note: CANCELLED_NOTE, cause: "cancelled" };
        }
      }

      // As for await-ui-element, a miss is `unmet` only while an armed layer's last read is
      // recent, for the JS layer at its own pace: a read takes up to jsBound, then a poll.
      const now = Date.now();
      const tolerance = darkTailToleranceMs(pollIntervalMs);
      const fresh =
        (lastArmedNativeAt !== undefined && now - lastArmedNativeAt <= tolerance) ||
        (lastArmedJsAt !== undefined &&
          now - lastArmedJsAt <= Math.max(tolerance, jsBound + pollIntervalMs));
      return timedOut(fresh ? "unmet" : "unreadable", false);

      function timedOut(cause: UnmetWaitCause, allStopped: boolean): WaitResult {
        const summaries: LayerSummary[] = layers.map(({ layer }) => {
          const last = latest.get(layer);
          const readable = latestReadable.get(layer);
          return {
            layer,
            armed: last?.readable === true ? last.armed : false,
            readable: readable !== undefined,
            ...(last?.stopped ? { stopped: true as const } : {}),
            requests: readable?.records.length ?? 0,
            ...(last?.note ? { note: last.note } : {}),
          };
        });
        const seen = [...latestReadable.values()].flatMap((read) => read.records);
        const misses = nearMisses(criteria, seen);
        const counts = summaries
          .map(
            (s) =>
              `${s.layer} ${s.readable ? s.requests : "not read"}${s.armed ? "" : " (not armed)"}`
          )
          .join(", ");
        const head = allStopped
          ? `No request matched (wanted: ${describeCriteria(criteria)}): capture is stopped on every marked layer, so only the requests captured between network-capture-start and network-capture-stop were searched.`
          : `No request since network-capture-start matched within this ${timeoutMs} ms wait (wanted: ${describeCriteria(criteria)}).`;
        const notes = summaries
          .filter((s) => s.note)
          .map((s) => `${s.layer}: ${s.note}`)
          .join("; ");
        const note = [
          head,
          `Requests since the start: ${counts}.`,
          notes ? `${notes}.` : undefined,
          misses.length > 0 ? `Nearest: ${misses.map(describeRecord).join("; ")}.` : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        return {
          success: false,
          elapsed: elapsed(),
          cause,
          note,
          nearMisses: misses,
          layers: summaries,
        };
      }
    },
  };
}
