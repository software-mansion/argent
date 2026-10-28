import { z } from "zod";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import {
  countStepsOnDisk,
  getFlowPath,
  getLegacyFlowPath,
  getRecordingSession,
  startRecordingSession,
  withFlowFileLock,
  writeNewFlowFile,
  clientFileDirective,
  serializeFlow,
  validateFlow,
  type FlowFile,
  type FlowSavedTo,
} from "./flow-utils";

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
  name: z
    .string()
    .describe(
      'Name for this e2e test (e.g. "settings-explore"): letters, digits, underscore and hyphen only.'
    ),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory (the directory that contains or should contain `.argent/e2e/`)."
    ),
  executionPrerequisite: z
    .string()
    .optional()
    .describe(
      'Fragments only: the app/device state assumed on entry (e.g. "Settings app open on General page"). ' +
        "Omit it for a standalone e2e test. restart-app has no chromium support, so a chromium " +
        "e2e test records as a fragment; add the `launch: { chromium: <app path> }` line to the YAML " +
        "afterward, deleting the executionPrerequisite line if you passed one, since an e2e test that starts " +
        "with a launch must not declare it."
    ),
});

export const flowStartRecordingTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    message: string;
    restarted?: true;
    discardedSteps?: number;
    flowFile: string;
    savedTo: FlowSavedTo;
  }
> = {
  id: "e2e-start-recording",
  description: `Start recording a new e2e test, resetting .argent/e2e/<name>.yaml to an empty e2e test and replacing any existing one.
Use when you want to capture a reusable sequence of device interactions for later replay.
Returns { message, flowFile, savedTo } and optionally { restarted, discardedSteps } if a live recording of the same e2e test was discarded.
Without a link, it creates that file and fails if the .argent/e2e/ directory cannot be created or the file cannot be written. Over a link (argent link or ARGENT_TOOLS_URL, also to 127.0.0.1), your client writes the file, and \`savedTo\` is its path on your computer, or null when that write failed.

Several e2e tests can be recorded at once, each keyed by the \`name\` + \`project_root\`
that every subsequent recording tool repeats, and one recording's steps never
land in another's file.

After starting, use e2e-add-step to append tool calls. Each step runs LIVE, so
give each concurrent recording its own device and pick a name unique to your
task. Read each step's \`message\`: it warns when a recorded await-ui-element did
not hold, or may fail once converted to \`await:\`/\`assert:\`. A wait nested in a
recorded run-sequence gets no such warning, so read its \`toolResult\`. For a
standalone e2e test, record a restart-app of the app under test as the FIRST step
(captured as the e2e test's \`launch\` step); for a reusable fragment, skip that and
pass executionPrerequisite instead. Use e2e-add-echo to add labels, and
e2e-add-script to run a local .mjs file and record it as a \`script:\` step.
Call e2e-finish-recording when done.

To remove or reorder steps, edit the .yaml file after e2e-finish-recording, not
during the recording: over a link, the next recorded step writes over your edit,
and without a link, an edit that renumbers the steps drops their warnings.`,
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
  services: () => ({}),
  async execute(_services, params, ctx) {
    // The type emerges from the steps: a first `restart-app` becomes a leading
    // `launch` (flow-add-step) and makes it e2e; an executionPrerequisite
    // documents a fragment.
    const flow: FlowFile = {
      executionPrerequisite: params.executionPrerequisite ?? "",
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
              ? await countStepsOnDisk(replaced.filePath)
              : replaced.flow.steps.length;

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
        message: `Restarted recording "${params.name}" — ${lost} was discarded and ` + reset,
        restarted: true,
        ...(discardedSteps === undefined ? {} : { discardedSteps }),
        flowFile,
        savedTo,
      };
    }

    return {
      message: `Started recording "${params.name}" e2e test`,
      flowFile,
      savedTo,
    };
  },
};
