import { FAILURE_CODES, FailureError } from "@argent/registry";

export interface CDPTarget {
  id: string;
  title: string;
  description: string;
  webSocketDebuggerUrl: string;
  deviceName?: string;
  /** Legacy inspector-proxy only. Its synthetic reload page reports "don't use". */
  vm?: string;
  reactNative?: {
    logicalDeviceId?: string;
    capabilities?: {
      nativePageReloads?: boolean;
      prefersFuseboxFrontend?: boolean;
      nativeSourceCodeFetching?: boolean;
    };
  };
}

export interface MetroInfo {
  port: number;
  projectRoot: string;
  targets: CDPTarget[];
}

/**
 * The legacy inspector-proxy advertises a synthetic page next to each real one
 * ("React Native Experimental (Improved Chrome Reloads)"), flagged with this vm.
 * It is not a JS runtime — a CDP session bound to it answers nothing — so it is
 * never a usable target. Dropping it here rather than at selection time also
 * means a list containing ONLY the decoy (the app-reload window, where the VM
 * reports no pages) correctly reads as "no targets" instead of connecting to it.
 */
const DECOY_VM = "don't use";

export async function discoverMetro(port: number): Promise<MetroInfo> {
  let statusRes: Response;
  try {
    statusRes = await fetch(`http://localhost:${port}/status`);
  } catch (err) {
    // Nothing listening at all: fetch rejects with a bare TypeError, which would
    // surface as an opaque 500. Report the same "not running" failure the caller
    // (and the metro-debugger skill) already knows how to act on.
    throw new FailureError(
      `Metro at port ${port} is not running (got: ${err instanceof Error ? err.message : String(err)}). ` +
        `Do not retry in a loop — the result will not change until Metro is started. ` +
        `Start Metro (e.g. \`npx react-native start\` or \`npx expo start\`) or ask the user, ` +
        `wait for it to report ready, then retry once.`,
      {
        error_code: FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING,
        failure_stage: "debugger_discover_metro_status",
        failure_area: "tool_server",
        error_kind: "network",
      }
    );
  }
  // The same classification applies to every network read in this probe
  // sequence, not just the initial connect: Metro going down BETWEEN reads
  // (accepted /status, died before the body or before /json/list) rejects with
  // a bare fetch/stream error that would otherwise escape as an opaque 500 —
  // exactly the unclassified failure the guard above exists to prevent.
  const notRunning = (stage: string, err: unknown) =>
    new FailureError(
      `Metro at port ${port} is not running (got: ${err instanceof Error ? err.message : String(err)}). ` +
        `Do not retry in a loop — the result will not change until Metro is started. ` +
        `Start Metro (e.g. \`npx react-native start\` or \`npx expo start\`) or ask the user, ` +
        `wait for it to report ready, then retry once.`,
      {
        error_code: FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "network",
      }
    );

  let statusText: string;
  try {
    statusText = await statusRes.text();
  } catch (err) {
    throw notRunning("debugger_discover_metro_status_body", err);
  }
  if (!statusText.includes("packager-status:running")) {
    throw new FailureError(
      `Metro at port ${port} is not running (got: ${statusText.slice(0, 100)}). ` +
        `Something else is listening on this port — it did not answer like Metro. ` +
        `Do not retry in a loop; find the port Metro actually runs on (or start it), then retry once.`,
      {
        error_code: FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING,
        failure_stage: "debugger_discover_metro_status",
        failure_area: "tool_server",
        error_kind: "network",
      }
    );
  }

  // Optional: only source-map / file:line resolution needs it. Without it the
  // source resolver declines to resolve at all, and SourceMapsRegistry loses one
  // of its candidate strategies (it can still match via the /[metro-project]/
  // alias and by suffix), so the worst case is "no location" rather than a wrong
  // one. Metro shipped with React Native 0.72 — which is what Vega/Kepler forks —
  // never sends this header, and hard-failing there would take down evaluate,
  // console logs and the network inspector, none of which touch source maps.
  const projectRoot = statusRes.headers.get("X-React-Native-Project-Root") ?? "";

  let listRes: Response;
  try {
    listRes = await fetch(`http://localhost:${port}/json/list`);
  } catch (err) {
    throw notRunning("debugger_discover_metro_list", err);
  }
  // Anything answering "packager-status:running" now reaches this parse, so do
  // not trust the body: a non-array (an HTML error page, a bare JSON string —
  // whose `.length` would sail through the check below) must land on the same
  // clean failure as an empty list, not a TypeError deeper in target selection.
  const parsed = await listRes.json().catch(() => null);
  const targets = (Array.isArray(parsed) ? (parsed as CDPTarget[]) : []).filter(
    (t) => t?.vm !== DECOY_VM
  );

  if (!targets.length) {
    throw new FailureError(
      `Metro at port ${port} has no CDP targets — is a React Native app connected? ` +
        `Do not retry immediately — this will not change until an app attaches. ` +
        `Launch or restart the RN app on the target device (launch-app / restart-app), ` +
        `wait a few seconds for the bundle to load, then retry once. On Android, a missing ` +
        `port reverse-proxy is the most common cause (see the metro-debugger skill's Android prerequisites).`,
      {
        error_code: FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS,
        failure_stage: "debugger_discover_metro_targets",
        failure_area: "tool_server",
        error_kind: "network",
      }
    );
  }

  return { port, projectRoot, targets };
}
