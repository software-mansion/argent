import { z } from "zod";
import { LAUNCH_PLATFORMS, type FileInputSpec, type ToolDefinition } from "@argent/registry";
import {
  countStepsOnDisk,
  getFlowPath,
  getLegacyFlowPath,
  getRecordingSession,
  startRecordingSession,
  withFlowFileLock,
  writeNewFlowFile,
  clientFileDirective,
  envRecordSchema,
  flowEnvProblem,
  parseRequires,
  RUNTIME_KINDS,
  serializeFlow,
  validateFlow,
  type FlowFile,
  type FlowSavedTo,
  fragmentShutdownNote,
  runDeferredShutdown,
  type FragmentShutdownReport,
} from "./flow-utils";
import { InvalidToolInputError, MACOS_APPS_FLAG } from "../../utils/capability";
import { resolveScriptEnv } from "./flow-script-step";
import { FLAG_ENUM_META_KEY } from "../../utils/flag-gated-text";

const MACOS_PLATFORM_FLAG = { [FLAG_ENUM_META_KEY]: { macos: MACOS_APPS_FLAG } };

/**
 * `project_root` is the AGENT's project; the probe says whether it also exists
 * on this host. A call without a link whose root is here (co-located) writes
 * the flow file here. A call over a link, or one whose root is not here, keeps
 * the recording in memory, and every mutating flow tool returns a client-write
 * directive, so the YAML lands in the agent's project instead of recreating its
 * layout here.
 */
const fileInputs: FileInputSpec[] = [
  { target: "project_root", path: "${project_root}", kind: "probe" },
];

const zodSchema = z.object({
  name: z.string().describe("E2E test name (letters, digits, `_`, `-`)."),
  project_root: z.string().describe("Absolute path to the project root containing `.argent/e2e/`."),
  executionPrerequisite: z
    .string()
    .optional()
    .describe(
      "Fragments only: entry state assumed. Omit for standalone tests (Chromium records as a fragment: for an Electron app, then add `launch: { chromium: <app path> }` and remove this). A browser booted with `browser` has no launch form and stays a fragment; never point `chromium:` at a browser binary."
    ),
  requires: z
    .object({
      platform: z
        .union([
          z.enum(LAUNCH_PLATFORMS).meta(MACOS_PLATFORM_FLAG),
          z.array(z.enum(LAUNCH_PLATFORMS).meta(MACOS_PLATFORM_FLAG)).min(1),
        ])
        .optional(),
      runtimeKind: z.enum(RUNTIME_KINDS).optional(),
    })
    .optional()
    .describe("Supported target filter (`platform` and/or `runtimeKind`, ANDed). Omit for any."),
  env: envRecordSchema(z.string())
    .optional()
    .describe("Top-level script env defaults. Supports `{{secret:NAME}}`."),
});

export const flowStartRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    restarted?: true;
    discardedSteps?: number;
    /** A restart: the kept shutdown of the discarded take's `run:` fragments, which it ran. */
    fragmentShutdown?: FragmentShutdownReport;
    e2eTestFile: string;
    /** @deprecated Same value as `e2eTestFile`, kept for clients that predate it. */
    flowFile: string;
    savedTo: FlowSavedTo;
  }
> = {
  id: "e2e-start-recording",
  description: `Start recording a new e2e test, resetting \`.argent/e2e/<name>.yaml\`. Starting over an existing test replaces the whole file, including its \`requires:\` and \`env:\` blocks (pass \`requires\` and \`env\` to keep them), and runs pending fragment cleanup on restart.
Use when capturing a reusable sequence of device actions for replay; load the \`argent-create-e2e\` skill first. Not for Apple TV or Android TV.
Record live steps with \`e2e-add-step\` (start standalone tests with \`restart-app\`; use \`executionPrerequisite\` for fragments), \`e2e-add-echo\`, and \`e2e-add-script\`, then call \`e2e-finish-recording\`. Edit the YAML only after finishing.
Returns \`{ message, e2eTestFile, savedTo, restarted?, discardedSteps?, fragmentShutdown? }\`. Fails if the target file or directory cannot be written.`,
  zodSchema,
  aliases: ["flow-start-recording"],
  interaction: {
    // Name the flow: concurrent recordings interleave in one log, and "flow
    // recording" would not say which.
    startedMsg: ({ params }) => `Starting recording of e2e test ${params.name}`,
    completedMsg: ({ params, result }) => {
      if (!result.restarted) return `Started recording e2e test ${params.name}`;
      // A plain "started" would hide that a live take was discarded.
      // `discardedSteps` is absent when the superseded file could not be read
      // or parsed - 0 is the answer a genuinely empty take gives - so do not
      // claim a count we do not have.
      const discarded = result.discardedSteps;
      return discarded === undefined
        ? `Restarted recording e2e test ${params.name}, discarding the previous take`
        : `Restarted recording e2e test ${params.name}, discarding ${discarded} ${discarded === 1 ? "step" : "steps"}`;
    },
    failedMsg: ({ params, failureSignal }) =>
      `Failed to start recording of e2e test ${params.name}: ${failureSignal.error_code}`,
  },
  fileInputs,
  // A restart may run the discarded take's fragment shutdown, on the device.
  longRunning: true,
  services: () => ({}),
  async execute(_services, params, ctx) {
    // The type emerges from the steps: a first `restart-app` becomes a leading
    // `launch` (flow-add-step) and makes it e2e; an executionPrerequisite
    // documents a fragment.
    if (params.env) {
      const problem = flowEnvProblem(params.env);
      if (problem) throw new InvalidToolInputError(`env ${problem}`);
    }
    const flow: FlowFile = {
      executionPrerequisite: params.executionPrerequisite ?? "",
      ...(params.requires ? { requires: parseRequires(params.requires) } : {}),
      ...(params.env && Object.keys(params.env).length > 0 ? { env: params.env } : {}),
      steps: [],
    };
    validateFlow(flow);
    const flowFile = serializeFlow(flow);

    // A call over a link keeps the flow on the client, also when this host has
    // a directory at the same path: a replay over that link reads the client
    // copy, so the recording must write it there. Without the header (no link,
    // an older client) the probe decides. No probe (direct invocation) means
    // the caller shares this filesystem, so host persistence stands.
    const probe = ctx?.fileInputs?.project_root;
    const persist = ctx?.linked || (probe && !probe.presentOnHost) ? "client" : "host";
    // A client released before the rename writes client files only under
    // `.argent/flows/` and drops a directive for `.argent/e2e/` without an
    // error, so its recording goes where it can save it.
    const filePath =
      persist === "client" && ctx?.legacyE2eDir
        ? getLegacyFlowPath(params.project_root, params.name)
        : getFlowPath(params.project_root, params.name);
    // After the path checks, which refuse a project_root the secret lookup
    // must not search from; before the existing file is replaced.
    if (params.env) resolveScriptEnv(params.env, params.project_root, ctx?.clientSecrets);

    // Truncate-and-register is one critical section: under the flow-file lock a
    // step from the take being discarded can neither slip in between the reset
    // and the swap nor land after both - it finds its session superseded and
    // fails.
    const { savedTo, replaced, discardedSteps } = await withFlowFileLock(
      params.project_root,
      params.name,
      async () => {
        // Read the take being discarded ONCE and drive both `restarted` and its
        // step count off that read. Count BEFORE the truncate destroys it, and
        // where it actually lives: on disk in host mode, since a hand-edit made
        // mid-recording is part of the take and the session's in-memory copy
        // only catches up on the next append (see {@link countStepsOnDisk}); in
        // client mode this host has no file and the in-memory copy IS the take.
        //
        // `replaced` is this read, NOT `startRecordingSession`'s return: awaits
        // sit between the two and {@link evictIfOverCapacity} runs under some
        // OTHER key's lock, so it can drop this key in that window — the return
        // would then report an already-truncated restart as a fresh start and
        // lose the count. This read is inside our own key's lock.
        const replaced = (await getRecordingSession(params.project_root, params.name)) ?? null;
        const discardedSteps =
          replaced === null
            ? undefined
            : replaced.persist === "host"
              ? await countStepsOnDisk(replaced.filePath, "both")
              : replaced.flow.steps.length + (replaced.flow.shutdown?.length ?? 0);

        let savedTo: FlowSavedTo;
        if (persist === "host") {
          await writeNewFlowFile(filePath, flowFile);
          savedTo = filePath;
        } else {
          savedTo = clientFileDirective(filePath, flowFile);
        }
        await startRecordingSession({
          name: params.name,
          projectRoot: params.project_root,
          persist,
          filePath,
          flow,
        });
        return { savedTo, replaced, discardedSteps };
      }
    );

    // Recordings are keyed per flow file, so only a same-key restart replaces
    // anything; starting a *different* flow abandons nothing to report.
    if (replaced) {
      // The discarded take's recorded fragments ran, so their kept shutdown
      // runs now, as it would have at its finish.
      const fragmentShutdown = await runDeferredShutdown(replaced, ctx);
      // Only claim the file was reset when this process reset it: in client mode
      // truncation waits on the client applying the directive, and a rejected
      // path or a failed write there comes back as `savedTo: null`.
      const reset =
        persist === "host"
          ? `${filePath} reset to an empty e2e test.`
          : `${filePath} is reset to an empty e2e test once your client applies \`savedTo\` ` +
            `(a null \`savedTo\` means it did not).`;
      // An unreadable or unparseable file leaves the loss uncounted, so report
      // the discard without a number rather than one the file disagrees with.
      const lost =
        discardedSteps === undefined
          ? "the previous take"
          : `the previous take (${discardedSteps} step${discardedSteps === 1 ? "" : "s"})`;
      return {
        message:
          `Restarted recording "${params.name}" — ${lost} was discarded and ` +
          reset +
          (fragmentShutdown ? ` ${fragmentShutdownNote(fragmentShutdown)}` : ""),
        restarted: true,
        ...(fragmentShutdown ? { fragmentShutdown } : {}),
        ...(discardedSteps === undefined ? {} : { discardedSteps }),
        e2eTestFile: flowFile,
        flowFile,
        savedTo,
      };
    }

    return {
      message: `Started recording "${params.name}" e2e test`,
      e2eTestFile: flowFile,
      flowFile,
      savedTo,
    };
  },
};
