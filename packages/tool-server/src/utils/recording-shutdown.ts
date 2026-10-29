import { ServiceState, type Registry } from "@argent/registry";
import { SCREEN_RECORDING_SESSION_NAMESPACE } from "../blueprints/screen-recording-session";

export function beginRecordingShutdown(registry: Registry): Promise<void> {
  const recordings = [...registry.getSnapshot().services.entries()].filter(
    ([urn, node]) =>
      urn.startsWith(`${SCREEN_RECORDING_SESSION_NAMESPACE}:`) &&
      (node.state === ServiceState.RUNNING || node.state === ServiceState.STARTING)
  );
  if (!recordings.length) return Promise.resolve();
  // Mark recordings TERMINATING before the serial registry disposal reaches them.
  const finishing = Promise.allSettled(recordings.map(([urn]) => registry.disposeService(urn)));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.stderr.write(
        "[screen-recording] Shutdown grace ended; pending recording output may be incomplete. Check the outputFile returned by start on the tool-server after encoding finishes; a server exit loses retrieval state.\n"
      );
      resolve();
    }, 1_500);
    void finishing.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
