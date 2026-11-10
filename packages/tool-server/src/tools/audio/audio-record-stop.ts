import { basename } from "node:path";
import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";
import { stopRecording } from "../../utils/ios-audio";
import { audioCapability, resolveAudioDevice, resolveAudioSession } from "./audio-target";

const zodSchema = z.object({
  udid: z.string().describe("Target iOS Simulator UDID from `list-devices`."),
  bundleId: z.string().describe("App passed to `audio-record-start`."),
});

type Params = z.infer<typeof zodSchema>;

/** Same hint as screen recordings: save durably instead of in the disposable cache. */
const RECORDINGS_DIR = ".argent/recordings";

interface AudioRecordStopResult {
  /** The finished recording (16-bit PCM WAV). */
  audio: ArtifactHandle;
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** Only when the app produced sound faster than it could be written; the gaps are in the file. */
  droppedFrames?: number;
  warning?: string;
}

export function createAudioRecordStopTool(
  registry: Registry
): ToolDefinition<Params, AudioRecordStopResult> {
  return {
    id: "audio-record-stop",
    description: `Stop the recording started by \`audio-record-start\` and retrieve the WAV file of what the app played.
Use when the sound you wanted to capture has finished playing.
Returns { audio, durationMs, sampleRate, channels, droppedFrames?, warning? }; audio is a downloadable artifact materialized to a local path. The WAV is 16-bit PCM at the sample rate of the device. A warning says when the recording is empty or may be incomplete.
Fails if the app is not being recorded.`,
    zodSchema,
    searchHint: "audio record stop finish save wav output speaker sound",
    interaction: {
      startedMsg: ({ params }) => `Stopping audio recording of ${params.bundleId}`,
      completedMsg: ({ result }) => `Saved audio recording ${result.audio.filename}`,
      failedMsg: ({ failureSignal }) =>
        `Failed to stop audio recording: ${failureSignal.error_code}`,
    },
    capability: audioCapability,
    requires: ["xcrun"],
    services: () => ({}),
    async execute(_services, params, ctx) {
      const device = await resolveAudioDevice("audio-record-stop", params.udid);
      const session = await resolveAudioSession(registry, device);
      const artifacts = requireArtifacts(ctx);
      const recording = await stopRecording(session, params.bundleId);
      const audio = await artifacts.register({
        hostPath: recording.path,
        kind: "audio-recording",
        mimeType: "audio/wav",
        // Drop the internal `argent-` temp-file prefix from the saved name.
        filename: basename(recording.path).replace(/^argent-/, ""),
        saveDir: RECORDINGS_DIR,
      });
      const result: AudioRecordStopResult = {
        audio,
        durationMs: recording.durationMs,
        sampleRate: recording.sampleRate,
        channels: recording.channels,
      };
      if (recording.droppedFrames > 0) result.droppedFrames = recording.droppedFrames;
      if (recording.warning) {
        result.warning = recording.warning;
      } else if (recording.durationMs === 0) {
        result.warning =
          `${params.bundleId} played nothing while it was recorded. Start the recording before the sound plays; ` +
          `sound played by web content or another process is not covered.`;
      }
      return result;
    },
  };
}
