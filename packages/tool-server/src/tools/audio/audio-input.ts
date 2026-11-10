import { z } from "zod";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import { assertSupported, InvalidToolInputError } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";
import {
  armAudio,
  clearAudioInput,
  listLiveApps,
  assertHookProto,
  readAppHook,
  type HookState,
  setAudioInput,
} from "../../utils/ios-audio";

const zodSchema = z.object({
  udid: z.string().describe("Target iOS Simulator UDID from `list-devices`."),
  source: z
    .enum(["file", "tone", "microphone"])
    .describe(
      "What apps hear as microphone input. `file`: the audio file in `path`. `tone`: a generated sine wave. " +
        "`microphone`: release the override, apps hear the host's real microphone again."
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Audio file to play as the microphone, required for source=file. Any format macOS decodes: wav, mp3, m4a, caf, aiff, flac."
    ),
  loop: z
    .boolean()
    .optional()
    .describe("source=file only. Default false: silence after the end of the file."),
  frequencyHz: z.number().min(20).max(20000).optional().describe("source=tone only. Default 1000."),
  amplitude: z
    .number()
    .min(0.01)
    .max(1)
    .optional()
    .describe("source=tone only, linear 0.01-1. Default 0.4."),
  bundleId: z
    .string()
    .optional()
    .describe(
      "App you are about to test. When set, the result says whether the audio hook is live in that app."
    ),
});

type Params = z.infer<typeof zodSchema>;

interface AudioInputResult {
  source: "file" | "tone" | "microphone";
  /** Length of the file after conversion. Only for source=file. */
  durationMs?: number;
  /** Apps whose audio hook is live right now, so they hear the source. */
  liveApps: string[];
  /** Only with `bundleId`: whether the hook is live in that app. */
  appReady?: boolean;
  message?: string;
}

const capability = { apple: { simulator: true } } as const;

// The picked file lives on the client's machine, so it crosses the file boundary like screenshot-diff's PNGs.
const fileInputs: FileInputSpec[] = [
  { target: "path", path: "${path}", kind: "file", optional: true },
];

export const audioInputTool: ToolDefinition<Params, AudioInputResult> = {
  id: "audio-input",
  interaction: {
    startedMsg: ({ params }) => `Setting simulator audio input to ${params.source}`,
    completedMsg: ({ params }) => `Set simulator audio input to ${params.source}`,
    failedMsg: ({ failureSignal }) => `Failed to set audio input: ${failureSignal.error_code}`,
  },
  capability,
  fileInputs,
  description: `Choose what apps in an iOS Simulator hear as microphone input: an audio file, a generated tone, or the real host microphone.
Use when testing recording, voice, speech recognition or call features without speaking into the host microphone. Replaces the samples the app reads, so the app needs no change and keeps using its normal audio APIs.
Apps launched after Argent armed the simulator carry the hook; pass bundleId to check (appReady). An app launched before that does not: call restart-app for it. The setting then applies to every armed app, can be changed while an app is recording, and survives app restarts. A reboot of the simulator clears the arming.
A file plays from its beginning at the moment you call this tool, and again each time an app opens a new audio input; after its end it plays silence unless loop is true. An app that keeps its audio session open between recordings does not open a new input, so the file does not restart when it records again: call this tool again right before the action that makes the app record. Set source=microphone to release the override.
Returns { source, durationMs?, liveApps, appReady?, message? }. liveApps lists the apps that hear the source now; with bundleId, appReady and message say whether that app does.
Fails if the file cannot be decoded, the simulator is not booted, or the target is a tvOS or remote simulator. Does not cover web content (WKWebView getUserMedia) or AVCaptureSession audio.`,
  searchHint: "audio microphone input mock fake inject voice speech sound file tone simulator mic",
  zodSchema,
  services: (params) => ({
    nativeDevtools: nativeDevtoolsRef(resolveDevice(params.udid)),
  }),
  async execute(services, params) {
    assertSupported("audio-input", capability, resolveDevice(params.udid));
    if (params.source === "file" && !params.path) {
      throw new InvalidToolInputError("source=file requires `path`.");
    }
    // Every call arms, including the release: recording the speaker needs the hook but no input override.
    await armAudio(params.udid, services.nativeDevtools as NativeDevtoolsApi);
    // An app on an older hook cannot be driven: say so before changing anything.
    const hook = params.bundleId ? await readAppHook(params.udid, params.bundleId) : undefined;
    if (hook?.state === "old-proto") assertHookProto(hook.status, params.bundleId!);
    if (params.source === "microphone") {
      clearAudioInput(params.udid);
      return withApps(params, { source: "microphone" }, hook?.state);
    }
    const applied =
      params.source === "file"
        ? await setAudioInput(params.udid, {
            kind: "file",
            path: params.path!,
            loop: params.loop ?? false,
          })
        : await setAudioInput(params.udid, {
            kind: "tone",
            frequencyHz: params.frequencyHz ?? 1000,
            amplitude: params.amplitude ?? 0.4,
          });
    return withApps(
      params,
      { source: applied.source, durationMs: applied.durationMs },
      hook?.state
    );
  },
};

function withApps(
  params: Params,
  result: Pick<AudioInputResult, "source" | "durationMs">,
  hook: HookState | undefined
): AudioInputResult {
  const out: AudioInputResult = { ...result, liveApps: listLiveApps(params.udid) };
  if (params.bundleId) {
    out.appReady = hook === "dormant" || hook === "active";
    if (!out.appReady) {
      out.message =
        hook === "stale"
          ? `${params.bundleId} has not reported its audio hook since it last started (or is not running). ` +
            `Retry in a moment; if it persists, call restart-app for it.`
          : `The audio hook is not live in ${params.bundleId}: it was launched before the simulator was armed. ` +
            `Call restart-app for it; the input is already set and applies as soon as it runs again.`;
    }
  }
  return out;
}
