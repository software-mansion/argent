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

interface MetroInfo {
  port: number;
  projectRoot: string;
  targets: CDPTarget[];
}

/**
 * The legacy inspector-proxy advertises a synthetic page next to each real one
 * ("React Native Experimental (Improved Chrome Reloads)") flagged with this vm.
 * It is not a JS runtime. Filtering it here rather than at selection time also
 * makes a list holding only the decoy read as "no targets".
 */
const DECOY_VM = "don't use";

export async function discoverMetro(port: number): Promise<MetroInfo> {
  let statusRes: Response;
  try {
    statusRes = await fetch(`http://localhost:${port}/status`);
  } catch (err) {
    // A bare fetch TypeError would escape as an opaque 500; report the
    // "not running" failure the caller (and the metro-debugger skill) acts on.
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
  // Metro can also die BETWEEN reads (accepted /status, gone before the body or
  // before /json/list); those rejections need the same classification.
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

  // Optional: only source-map / file:line resolution needs it, and its absence
  // costs a location rather than yielding a wrong one (source fragments fail
  // closed; SourceMapsRegistry takes no project root — it fetches the map a
  // Debugger.scriptParsed names, drains it and keeps nothing, so it has no
  // source path to resolve against). Legacy Metro (RN 0.72, which Vega forks)
  // never sends it, and hard-failing there would also take down evaluate,
  // console logs and the network inspector.
  const projectRoot = statusRes.headers.get("X-React-Native-Project-Root") ?? "";

  let listRes: Response;
  try {
    listRes = await fetch(`http://localhost:${port}/json/list`);
  } catch (err) {
    throw notRunning("debugger_discover_metro_list", err);
  }
  // Anything answering "packager-status:running" reaches this parse, so a
  // non-array body (an HTML error page, or a bare JSON string whose `.length`
  // would sail through the check below) must land on the same clean failure as
  // an empty list, not a TypeError deeper in target selection.
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
