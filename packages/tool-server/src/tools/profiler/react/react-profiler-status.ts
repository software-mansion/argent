import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
} from "../../../blueprints/react-profiler-session";
import {
  REACT_NATIVE_PROFILER_SETUP_SCRIPT,
  READ_STATE_SCRIPT,
} from "../../../utils/react-profiler/scripts";
import type { ProfilerSessionOwner } from "../../../utils/react-profiler/session-ownership";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .describe(
      "Device logicalDeviceId from debugger-connect (iOS simulator UDID or Android logicalDeviceId)."
    ),
});

type ReadStateResult =
  | { hookExists: false }
  | { hookExists: true; rendererInterfaceFound: false }
  | {
      hookExists: true;
      rendererInterfaceFound: true;
      isRunning: boolean;
      owner: ProfilerSessionOwner | null;
      nowEpochMs: number;
    };

type SessionStatus = "active" | "taken_over" | "stopped" | "no_react_runtime";

interface StatusResponse extends Record<string, unknown> {
  hook_exists: boolean;
  renderer_interface_found: boolean;
  is_running: boolean;
  current_session_id: string | null;
  current_owner: ProfilerSessionOwner | null;
  session_status: SessionStatus;
  note: string;
}

export function createReactProfilerStatusTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, Record<string, unknown>> {
  return {
    id: "react-profiler-status",
    description: `Check the state of the React profiler session without side effects. Use after an interruption (debugger disconnect, unexpected error, agent pause) to decide whether to continue with react-profiler-stop, start a new session, or reconnect the debugger. Ownership is verified server-side against this tool-server's in-memory session — no token-threading is required. Returns { session_status, is_running, current_owner, … }. If this tool-server process restarted after react-profiler-start, status will report 'taken_over'; use react-profiler-start { force: true } to reclaim.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params): Promise<StatusResponse> {
      const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}:${params.device_id}`;

      const noRuntime = (note: string): StatusResponse => ({
        hook_exists: false,
        renderer_interface_found: false,
        is_running: false,
        current_session_id: null,
        current_owner: null,
        session_status: "no_react_runtime",
        note,
      });

      let api: ReactProfilerSessionApi;
      try {
        api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);
      } catch {
        return noRuntime(
          "Unable to resolve a React profiler session — the Hermes runtime may not be reachable. Reconnect the debugger and retry."
        );
      }

      const cdp = api.cdp;
      if (!cdp.isConnected()) {
        return noRuntime(
          "CDP connection is not available — the debugger may be disconnected or the app isn't a dev build."
        );
      }

      // Idempotent; safe to re-run.
      try {
        await cdp.evaluate(REACT_NATIVE_PROFILER_SETUP_SCRIPT);
      } catch {
        /* non-fatal — READ_STATE_SCRIPT still works without the wrapper */
      }

      let stateJson: string | undefined;
      try {
        stateJson = (await cdp.evaluate(READ_STATE_SCRIPT)) as string | undefined;
      } catch {
        return noRuntime(
          "Failed to evaluate state script on the Hermes runtime. The debugger may have been disconnected."
        );
      }
      if (!stateJson) {
        return noRuntime(
          "No value returned while reading React profiler state. The Hermes runtime may be unavailable."
        );
      }

      const state = JSON.parse(stateJson) as ReadStateResult;

      if (!state.hookExists) {
        return {
          hook_exists: false,
          renderer_interface_found: false,
          is_running: false,
          current_session_id: null,
          current_owner: null,
          session_status: "no_react_runtime",
          note: "React DevTools hook not attached — debugger may be disconnected or the app isn't a dev build.",
        };
      }

      if (!("rendererInterfaceFound" in state) || !state.rendererInterfaceFound) {
        return {
          hook_exists: true,
          renderer_interface_found: false,
          is_running: false,
          current_session_id: null,
          current_owner: null,
          session_status: "no_react_runtime",
          note: "No React renderer attached yet — the app hasn't rendered its first commit.",
        };
      }

      const owner = state.owner;
      const currentSessionId = owner?.sessionId ?? null;

      if (!state.isRunning) {
        return {
          hook_exists: true,
          renderer_interface_found: true,
          is_running: false,
          current_session_id: currentSessionId,
          current_owner: owner,
          session_status: "stopped",
          note: "No profiling session is currently running. If you expected to be profiling, the session ended — call react-profiler-start to begin a new one; prior data is not recoverable.",
        };
      }

      if (!owner) {
        return {
          hook_exists: true,
          renderer_interface_found: true,
          is_running: true,
          current_session_id: null,
          current_owner: null,
          session_status: "taken_over",
          note: "A profiling session is running but its ownership is unattributable — likely started by a foreign DevTools client without our setup script, or cleared in a narrow window. Treat as lost and restart.",
        };
      }

      const isMine = api.sessionId !== null && owner.sessionId === api.sessionId;

      return {
        hook_exists: true,
        renderer_interface_found: true,
        is_running: true,
        current_session_id: owner.sessionId,
        current_owner: owner,
        session_status: isMine ? "active" : "taken_over",
        note: isMine
          ? "Your profiling session is still running. Call react-profiler-stop to collect the data, or continue profiling."
          : "A different profiling session is running (another tool-server instance took over, or this process restarted after start). Data from the prior session is lost at the takeover moment. Use react-profiler-start { force: true } to reclaim.",
      };
    },
  };
}
