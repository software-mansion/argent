import { FAILURE_CODES, FailureError } from "@argent/registry";

export interface CDPTarget {
  id: string;
  title: string;
  description: string;
  webSocketDebuggerUrl: string;
  deviceName?: string;
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

export async function discoverMetro(port: number): Promise<MetroInfo> {
  const statusRes = await fetch(`http://localhost:${port}/status`);
  const statusText = await statusRes.text();
  if (!statusText.includes("packager-status:running")) {
    throw new FailureError(
      `Metro at port ${port} is not running (got: ${statusText.slice(0, 100)})`,
      {
        error_code: FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING,
        failure_stage: "debugger_discover_metro_status",
        failure_area: "tool_server",
        error_kind: "network",
      }
    );
  }

  const projectRoot = statusRes.headers.get("X-React-Native-Project-Root") ?? "";
  if (!projectRoot) {
    throw new FailureError(
      `Metro at port ${port} did not return X-React-Native-Project-Root header`,
      {
        error_code: FAILURE_CODES.DEBUGGER_METRO_PROJECT_ROOT_MISSING,
        failure_stage: "debugger_discover_metro_project_root",
        failure_area: "tool_server",
        error_kind: "network",
      }
    );
  }

  const listRes = await fetch(`http://localhost:${port}/json/list`);
  const targets = (await listRes.json()) as CDPTarget[];

  if (!targets?.length) {
    throw new FailureError(
      `Metro at port ${port} has no CDP targets — is a React Native app connected?`,
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
