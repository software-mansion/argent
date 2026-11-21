import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { startRecording } from "../../utils/ios-audio";
import { audioCapability, resolveAudioDevice, resolveAudioSession } from "./audio-target";

const zodSchema = z.object({
  udid: z.string().describe("Target iOS Simulator UDID from `list-devices`."),
  bundleId: z.string().describe("App to record; it must be running."),
  muteOutput: z
    .boolean()
    .optional()
    .describe("Silence the app on the host speakers while recording. Default false."),
});

type Params = z.infer<typeof zodSchema>;

interface AudioRecordStartResult {
  status: "recording";
  bundleId: string;
  muteOutput: boolean;
}

export function createAudioRecordStartTool(
  registry: Registry
): ToolDefinition<Params, AudioRecordStartResult> {
  return {
    id: "audio-record-start",
    description: `Start recording what an app in an iOS Simulator plays into a WAV file; \`audio-record-stop\` returns it.
Call it before the action that makes the app play.`,
    zodSchema,
    searchHint: "audio record output speaker sound capture app playback wav start",
    interaction: {
      startedMsg: ({ params }) => `Starting audio recording of ${params.bundleId}`,
      completedMsg: ({ params }) => `Started audio recording of ${params.bundleId}`,
      failedMsg: ({ failureSignal }) =>
        `Failed to start audio recording: ${failureSignal.error_code}`,
    },
    capability: audioCapability,
    requires: ["xcrun"],
    services: () => ({}),
    async execute(_services, params) {
      const device = await resolveAudioDevice("audio-record-start", params.udid);
      const session = await resolveAudioSession(registry, device);
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      // Scratch like screen recordings: the client copies the artifact to .argent/recordings on stop.
      const outputPath = path.join(os.tmpdir(), `argent-audio-${params.bundleId}-${stamp}.wav`);
      const muteOutput = params.muteOutput ?? false;
      await startRecording(session, params.bundleId, outputPath, muteOutput);
      return { status: "recording", bundleId: params.bundleId, muteOutput };
    },
  };
}
