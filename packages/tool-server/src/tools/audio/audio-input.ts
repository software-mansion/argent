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
        "`file` plays `path`, `tone` a sine wave, `microphone` restores the real microphone."
      ),
    path: z.string().optional().describe("Audio file, required for source=file."),
    // Not .int(): zod's int stops at 2^53, and any count must work. Advertised as an integer all the same.
    plays: z
      .number()
      .min(1)
      .refine(Number.isInteger, { message: "Must be a whole number." })
      .meta({ type: "integer" })
      .optional()
      .describe("source=file only. Times the file plays. Default 1."),
    frequencyHz: z
      .number()
      .min(20)
      .max(20000)
      .optional()
      .describe("source=tone only. Default 1000."),
    amplitude: z.number().min(0.01).max(1).optional().describe("source=tone only. Default 0.4."),
    bundleId: z.string().optional().describe("App under test; the result then reports `appReady`."),
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
    description: `Set what apps in an iOS Simulator hear as microphone input: an audio file, a tone, or the real microphone.
A file starts playing on this call, so call it right before the action that makes the app record.`,
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
    // afconvert decodes a long file for up to a minute, past the 30s MCP fetch timeout.
    longRunning: true,
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
              plays: params.plays ?? 1,
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
          ? `${params.bundleId} has not loaded the audio hook yet: retry, then call restart-app if it persists.`
          : `The audio hook is not live in ${params.bundleId}: call restart-app for it.`;
    }
  }
  return out;
}
