import { z } from "zod";
import type { FileInputSpec, Registry, ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef, type NativeDevtoolsApi } from "../../blueprints/native-devtools";
import {
  armAudio,
  assertHookProto,
  clearAudioInput,
  listLiveApps,
  readAppHook,
  setAudioInput,
  type AudioSession,
  type HookState,
} from "../../utils/ios-audio";
import { audioCapability, resolveAudioDevice, resolveAudioSession } from "./audio-target";

const zodSchema = z
  .object({
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
      .describe("Audio file to play as the microphone: wav, mp3, m4a, caf, aiff, flac."),
    loop: z
      .boolean()
      .optional()
      .describe("source=file only. Default false: silence after the end of the file."),
    frequencyHz: z
      .number()
      .min(20)
      .max(20000)
      .optional()
      .describe("source=tone only. Default 1000."),
    amplitude: z
      .number()
      .min(0.01)
      .max(1)
      .optional()
      .describe("source=tone only, linear. Default 0.4."),
    bundleId: z
      .string()
      .optional()
      .describe(
        "App you are about to test. When set, the result says whether the audio hook is live in that app."
      ),
  })
  .superRefine((params, ctx) => {
    if (params.source === "file" && !params.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source=file requires `path`.",
        path: ["path"],
      });
    }
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

// The picked file lives on the client's machine, so it crosses the file boundary like screenshot-diff's PNGs.
const fileInputs: FileInputSpec[] = [
  { target: "path", path: "${path}", kind: "file", optional: true },
];

export function createAudioInputTool(registry: Registry): ToolDefinition<Params, AudioInputResult> {
  return {
    id: "audio-input",
    description: `Choose what apps in an iOS Simulator hear as microphone input: an audio file, a generated tone, or the real host microphone.
Use when testing recording, voice, speech recognition or call features without speaking into the host microphone. The app needs no change.
Apps launched after Argent armed the simulator carry the audio hook; pass bundleId to check (appReady). Call restart-app for an app launched before that. The setting applies to every armed app and survives app restarts.
A file plays from its beginning when you call this tool, and again each time an app opens a new audio input. An app that keeps its audio session open does not restart the file: call this tool again right before the action that makes the app record. source=file requires path.
Returns { source, durationMs?, liveApps, appReady?, message? }.
Fails if the file cannot be decoded, the simulator is not booted, or the target is not a local iOS Simulator. Does not cover web content or AVCaptureSession audio.`,
    zodSchema,
    searchHint:
      "audio microphone input mock fake inject voice speech sound file tone simulator mic",
    interaction: {
      startedMsg: ({ params }) => `Setting simulator audio input to ${params.source}`,
      completedMsg: ({ params }) => `Set simulator audio input to ${params.source}`,
      failedMsg: ({ failureSignal }) => `Failed to set audio input: ${failureSignal.error_code}`,
    },
    capability: audioCapability,
    requires: ["xcrun"],
    fileInputs,
    // Resolved inside execute, after the platform checks: an eager native-devtools service would start
    // for a device the audio tools refuse.
    services: () => ({}),
    async execute(_services, params) {
      const device = await resolveAudioDevice("audio-input", params.udid);
      const ref = nativeDevtoolsRef(device);
      const devtools = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
      const session = await resolveAudioSession(registry, device);
      // Every call arms, including the release: recording the speaker needs the hook but no input override.
      await armAudio(session, devtools);
      // An app on an older hook cannot be driven: say so before changing anything.
      const hook = params.bundleId ? await readAppHook(session, params.bundleId) : undefined;
      if (hook?.state === "old-proto") assertHookProto(hook.status, params.bundleId!);
      if (params.source === "microphone") {
        clearAudioInput(session);
        return withApps(session, params, { source: "microphone" }, hook?.state);
      }
      const applied =
        params.source === "file"
          ? await setAudioInput(session, {
              kind: "file",
              path: params.path!,
              loop: params.loop ?? false,
            })
          : await setAudioInput(session, {
              kind: "tone",
              frequencyHz: params.frequencyHz ?? 1000,
              amplitude: params.amplitude ?? 0.4,
            });
      return withApps(
        session,
        params,
        { source: applied.source, durationMs: applied.durationMs },
        hook?.state
      );
    },
  };
}

function withApps(
  session: AudioSession,
  params: Params,
  result: Pick<AudioInputResult, "source" | "durationMs">,
  hook: HookState | undefined
): AudioInputResult {
  const out: AudioInputResult = { ...result, liveApps: listLiveApps(session) };
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
