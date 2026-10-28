import { z } from "zod";
import { ServiceState, isLiveServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import { isExternalDeviceUrn } from "../../utils/external-devices";
import {
  DEVICE_OWNED_NAMESPACES,
  PORT_KEYED_NAMESPACES,
  deviceIdOwningUrn,
  isDeviceServiceUrn,
  unnameableSessionUrns,
} from "./device-services";

const zodSchema = z
  .object({
    devices: z
      .array(z.string())
      .optional()
      .describe(
        "Ids of the devices THIS session used (iOS UDID / Android serial / Chromium id), to scope the teardown to."
      ),
  })
  // `.strict()` because omitting `devices` is the machine-wide sweep: a
  // misspelled key must be a validation error, not be stripped down to it.
  // `udids` is the natural slip — sibling tools spell the device parameter
  // `udid` — and under a stripping schema it would tear down every other
  // agent's devices while the caller believed it scoped, with `unmatched`
  // unreachable on that path so nothing in the response says otherwise.
  .strict();

export function createStopAllSimulatorServersTool(
  registry: Registry
): ToolDefinition<
  z.infer<typeof zodSchema>,
  { stopped: string[]; unmatched?: string[]; left_running?: string[]; aborted?: true }
> {
  return {
    id: "stop-all-simulator-servers",
    description: `Stop the services a device owns - simulator-server processes (iOS + Android), native devtools, the iOS accessibility service, TV-control daemons, Chromium CDP sessions, screen recordings, native profiler sessions, and JS-runtime debugger sessions along with the network inspectors and React profiler sessions that ride on them - freeing their spawned processes, sockets and ports. Call this when the user asks to clean up or ends the session, or when a skill tells you to recycle a device's services mid-flow - not just because a task finished, since the next task reuses these services and would start cold again.
PASS \`devices\` with the device ids this session used: one tool-server serves every agent, subagent and CLI call using this argent install, and an unscoped call tears down THEIR devices too. Omit \`devices\` only when a machine-wide cleanup is what you actually want. An EMPTY array stops nothing; it does not ask for the machine-wide sweep.
A JS-runtime debugger session is keyed by the id you called \`debugger-connect\` with. On a Metro serving two or more devices that id is not a udid or serial - connect refuses those and tells you to re-target with the \`logicalDeviceId\` it returns - so a scope built from \`list-devices\` ids cannot reach that session. Pass any such \`logicalDeviceId\` in \`devices\` ALONGSIDE the device id.
Returns { stopped }: the URNs of the live services that were shut down; empty means nothing was still running. { unmatched }, present only when a supplied id owns no service here, lists those ids, so a typo or a device NAME passed instead of an id does not read as a clean machine. It is NOT proof the id is wrong: a Vega device you only booted and drove with the remote registers no service and lands here, as does any device this session never started anything on. { left_running } lists the URNs of live debugger sessions (and the network inspectors / React profiler sessions riding on them) whose id no device scope can name; re-call with the id after each URN's \`<namespace>:<port>:\` prefix to reap them. { aborted: true } means the request was cancelled part-way: the rest was left untouched and \`unmatched\` / \`left_running\` were not computed.
Fails if the input has an unknown key (e.g. \`udids\` instead of \`devices\`); otherwise it always succeeds, and reaping nothing is a result, not a failure.`,
    zodSchema,
    interaction: {
      // "all" only holds for the unscoped sweep; a scoped call touches just the
      // ids it was given.
      startedMsg: ({ params }) => {
        const devices = params?.devices;
        return devices
          ? `Stopping simulator servers for ${devices.length} ${devices.length === 1 ? "device" : "devices"}`
          : "Stopping all simulator servers";
      },
      completedMsg: ({ result }) => {
        const n = result.stopped.length;
        const base = `Stopped ${n} simulator ${n === 1 ? "server" : "servers"}`;
        // Without this, a teardown that reaped nothing because every id was
        // mistyped reads as "Stopped 0 simulator servers" on a clean machine.
        const unmatched = result.unmatched;
        const notes: string[] = [];
        if (unmatched?.length) {
          notes.push(
            `${unmatched.length} supplied ${unmatched.length === 1 ? "id" : "ids"} matched no service`
          );
        }
        // Same reason: a session no device scope can name still holds a CDP
        // socket and a bound port.
        const left = result.left_running;
        if (left?.length) {
          notes.push(
            `${left.length} debugger ${left.length === 1 ? "session" : "sessions"} left running`
          );
        }
        return notes.length ? `${base} (${notes.join("; ")})` : base;
      },
      failedMsg: ({ failureSignal }) =>
        `Failed to stop simulator servers: ${failureSignal.error_code}`,
    },
    services: () => ({}),
    async execute(_services, params, ctx) {
      const devices = params.devices;
      // Present-but-empty scopes to nothing rather than falling back to the
      // machine-wide sweep, which would tear down other agents' services.
      const scoped = devices !== undefined;
      const snapshot = registry.getSnapshot();
      const stopped: string[] = [];
      const matchedIds = new Set<string>();
      // Live port-keyed services this scope did NOT claim; unclaimed services
      // of any other namespace are other agents' devices, left alone by design.
      const survivors: string[] = [];
      let aborted = false;
      for (const [urn, entry] of snapshot.services) {
        // Checked between disposals rather than inside one: a dispose already
        // under way finishes, since abandoning a blueprint mid-teardown leaks
        // the handles this tool exists to free.
        if (ctx?.signal?.aborted) {
          aborted = true;
          break;
        }
        const matchedId = scoped
          ? deviceIdOwningUrn(urn, DEVICE_OWNED_NAMESPACES, devices)
          : undefined;
        const matches = scoped
          ? matchedId !== undefined
          : isDeviceServiceUrn(urn, DEVICE_OWNED_NAMESPACES);
        // Ownership counts regardless of state: `disposeService` leaves the
        // node in place as IDLE, so a device this session already stopped would
        // otherwise be reported unmatched by the next scoped call.
        if (matchedId !== undefined) matchedIds.add(matchedId.toLowerCase());
        if (matches && entry.state !== ServiceState.IDLE) {
          // An ERROR node (e.g. a tvOS SimulatorServer that refused to start)
          // is disposed too, but was never a running server, so it is not
          // reported stopped.
          const wasLive = isLiveServiceState(entry.state);
          await registry.disposeService(urn);
          /**
           * A device from an external provider is disposed (dropping our
           * cached handle) but never reported as stopped. Its `dispose()` is a
           * no-op by design, so nothing was actually shut down and claiming
           * otherwise would tell the agent it had cleaned up a server it does
           * not own.
           */
          if (wasLive && !isExternalDeviceUrn(urn)) stopped.push(urn);
        } else if (
          scoped &&
          isLiveServiceState(entry.state) &&
          isDeviceServiceUrn(urn, PORT_KEYED_NAMESPACES)
        ) {
          survivors.push(urn);
        }
      }
      // The rest of the snapshot was never visited, so `unmatched` would read
      // an id the sweep never reached as a typo, and `left_running` would miss
      // sessions still up. Report the partial teardown as partial.
      if (aborted) return { stopped, aborted: true };
      if (!scoped) return { stopped };
      // A scoped stop that named an id owning nothing is indistinguishable
      // from a clean machine unless we say so — and when that id is a typo, its
      // device's services are being left running. Compared AND de-duplicated
      // case-insensitively to match the lookup: two spellings of one id are one
      // mistake, reported in the caller's first spelling.
      const seen = new Set<string>();
      const unmatched = devices.filter((id) => {
        const key = id.toLowerCase();
        if (matchedIds.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // A debugger session opened against a multi-device Metro is keyed by the
      // `logicalDeviceId` Metro echoed, which no `list-devices` id equals — so
      // no `devices` scope can reap it, and the ids that DID match keep it out
      // of `unmatched`. Name it so the caller can re-call with that id.
      const leftRunning = unnameableSessionUrns(survivors);
      const result: { stopped: string[]; unmatched?: string[]; left_running?: string[] } = {
        stopped,
      };
      if (unmatched.length > 0) result.unmatched = unmatched;
      if (leftRunning.length > 0) result.left_running = leftRunning;
      return result;
    },
  };
}
