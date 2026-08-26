import { z } from "zod";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import {
  countStepsOnDisk,
  describeRequires,
  getFlowPath,
  getRecordingSession,
  requiresOnDisk,
  startRecordingSession,
  withFlowFileLock,
  writeNewFlowFile,
  clientFileDirective,
  serializeFlow,
  validateFlow,
  type FlowFile,
  type FlowSavedTo,
} from "./flow-utils";

const zodSchema = z.object({
  name: z
    .string()
    .describe(
      'Name for this flow (e.g. "settings-explore") — letters, digits, underscore and hyphen only.'
    ),
  project_root: z
    .string()
    .describe(
      "Absolute path to the project root directory (the directory that contains or should contain `.argent/flows/`). The flow file is created at `<project_root>/.argent/flows/<name>.yaml`."
    ),
  executionPrerequisite: z
    .string()
    .optional()
    .describe(
      'Fragments only: the app/device state assumed on entry (e.g. "Settings app open on General page"). ' +
        "For a self-contained e2e flow, omit this and record a `restart-app` as the first step instead — " +
        "it is captured as the flow's `launch` step. restart-app has no chromium support, so a chromium " +
        "flow records as a fragment; add the `launch: { chromium: <app path> }` line to the YAML " +
        "afterward, deleting the executionPrerequisite line if you passed one — a flow that starts " +
        "with a launch must not declare it."
    ),
});

/**
 * `project_root` is the AGENT's project; the probe says whether it also exists
 * on this host. If it does (co-located, or a synced checkout) the flow file is
 * written here; if it doesn't (remote tool-server) the recording is kept in
 * memory and every mutating flow tool returns a client-write directive, so the
 * YAML lands in the agent's project instead of recreating its layout here.
 */
const fileInputs: FileInputSpec[] = [
  { target: "project_root", path: "${project_root}", kind: "probe" },
];

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
  id: "flow-start-recording",
  interaction: {
    // Name the flow: concurrent recordings interleave in one log, and "flow
    // recording" would not say which.
    startedMsg: ({ params }) => `Starting recording of flow ${params.name}`,
    completedMsg: ({ params, result }) => {
      if (!result.restarted) return `Started recording flow ${params.name}`;
      // A plain "started" would hide that a live take was discarded.
      // `discardedSteps` is absent when the superseded file could not be read
      // or parsed - 0 is the answer a genuinely empty take gives - so do not
      // claim a count we do not have.
      const discarded = result.discardedSteps;
      return discarded === undefined
        ? `Restarted recording flow ${params.name}, discarding the previous take`
        : `Restarted recording flow ${params.name}, discarding ${discarded} ${discarded === 1 ? "step" : "steps"}`;
    },
    failedMsg: ({ params, failureSignal }) =>
      `Failed to start recording of flow ${params.name}: ${failureSignal.error_code}`,
  },
  description: `Start recording a new flow, resetting .argent/flows/<name>.yaml to an empty flow and replacing any existing one (an existing \`requires:\` block survives the reset when the flow file is on this host and parses, or - if that file was deleted since - when a live recording of the same flow still carries it: against a remote tool-server this host never reads that file, and an unparseable one carries nothing - in those cases nothing survives, the message says so, and re-adding a block by hand is the only way back).
Use when you want to capture a reusable sequence of device interactions for later replay.
Returns { message, flowFile, savedTo } and optionally { restarted, discardedSteps } if a live recording of the same flow was discarded.
Whether this server writes that file depends on where your project is: co-located, it creates it and fails if the .argent/flows/ directory cannot be created or the file cannot be written; against a remote tool-server it writes nothing and \`savedTo\` is a directive your client applies (a null \`savedTo\` back means it did not).

Several flows can be recorded at once — each keyed by the \`name\` + \`project_root\`
that every subsequent recording tool repeats — and one recording's steps never
land in another's file. Steps still run LIVE, so give each concurrent recording
its own device and pick a name unique to your task.

After starting, use flow-add-step to append tool calls — each step is executed
LIVE so you can verify it works before it gets recorded. Read each step's
\`message\`: an await-ui-element whose condition never held is still recorded (it
returns success:false rather than failing), and a check that passes live can
still fail once polished into an \`await:\`/\`assert:\` directive, which resolves
against a different tree. flow-add-step warns about both when you record the
wait DIRECTLY. A wait nested inside a recorded run-sequence gets neither warning
— that tool reports its own shape — so for those, read \`toolResult\`. For a self-contained
e2e flow, record a restart-app of the app under test as the FIRST step (captured
as the flow's \`launch\` step); for a reusable fragment, skip that and pass
executionPrerequisite instead. Use flow-add-echo to add labels. Call
flow-finish-recording when done.

If a recorded step turns out to be wrong, edit the .yaml file directly to
remove or reorder steps - after flow-finish-recording, not during the
recording. Against a remote client the in-memory copy is authoritative and
every write serializes it over your edit; in host mode the recorder re-reads
the file before each append, so a mid-recording edit renumbers the steps and
costs the finish the cross-tree verdicts anchored to them.`,
  zodSchema,
  fileInputs,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const filePath = getFlowPath(params.project_root, params.name);

    // No probe (older client, direct invocation) means the caller shares this
    // filesystem — the pre-boundary assumption — so host persistence stands.
    const probe = ctx?.fileInputs?.project_root;
    const persist = probe && !probe.presentOnHost ? "client" : "host";

    // Truncate-and-register is one critical section: under the flow-file lock a
    // step from the take being discarded can neither slip in between the reset
    // and the swap nor land after both - it finds its session superseded and
    // fails.
    const { savedTo, replaced, discardedSteps, flowFile, carried, unwitnessed } =
      await withFlowFileLock(params.project_root, params.name, async () => {
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

        // `requires` is the one FlowFile field no tool can write back, so the
        // reset carries it forward instead of silently unfencing the flow. Host
        // only: the file about to be truncated is the source, with the take
        // being replaced standing in where that file is gone. Client mode has
        // neither - a session's in-memory `requires` comes from this very
        // expression, so by induction it is undefined in every client-mode
        // session and the message below can only warn that a block MAY have
        // been lost: whether that file ever held one is unknowable from here.
        const onDisk = persist === "host" ? await requiresOnDisk(filePath) : undefined;
        // A READABLE file is the authority, hand-edits included: one that parses
        // and declares none means the flow was unfenced on purpose, so the block
        // dies with it. A DELETED or EMPTIED one answers nothing, and there the
        // take being restarted is the last witness - host mode re-reads the file
        // into `session.flow` at every append, so the block it holds came from
        // this same file.
        //
        // A file that could not be read or parsed carries nothing AND is about
        // to be truncated, so whether it was fenced is now unknowable - reported
        // rather than passed off as an unfenced flow, and not answered from the
        // session either: such a file may have been mid-edit on its `requires`
        // line, which is the one thing the in-memory copy cannot know.
        const unwitnessed = onDisk?.unwitnessed;
        const carried =
          unwitnessed === "absent" || unwitnessed === "empty"
            ? replaced?.flow.requires
            : onDisk?.requires;

        // The type emerges from the steps: a first `restart-app` becomes a
        // leading `launch` (flow-add-step) and makes it e2e; an
        // executionPrerequisite documents a fragment.
        const flow: FlowFile = {
          executionPrerequisite: params.executionPrerequisite ?? "",
          ...(carried ? { requires: carried } : {}),
          steps: [],
        };
        // skipRequires: the carried block is preserved verbatim, not judged -
        // flow-finish-recording and the run path are the gates.
        validateFlow(flow, { skipRequires: true });
        const flowFile = serializeFlow(flow);

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
        return { savedTo, replaced, discardedSteps, flowFile, carried, unwitnessed };
      });

    // The reset result otherwise reads as a fully empty flow, so say what became
    // of the block - and that hand-editing the YAML is the only way to set one.
    const requiresNote = carried
      ? unwitnessed
        ? ` The previous file was ${unwitnessed === "empty" ? "empty" : "gone"}, so the requires block (${describeRequires(carried)}) was carried over from the take being restarted - edit the YAML to change it.`
        : ` Kept the existing requires block (${describeRequires(carried)}) - edit the YAML to change it.`
      : unwitnessed === "unparsed"
        ? " The previous file did not parse, so any requires block it held was dropped - re-add it by hand if the flow was fenced."
        : unwitnessed === "unreadable"
          ? " The previous file could not be read, so any requires block it held was dropped - re-add it by hand if the flow was fenced."
          : persist === "client"
            ? " This host cannot read the client-side flow file, so any requires block it may have held was not carried over - re-add it by hand if the flow was fenced."
            : "";

    // Recordings are keyed per flow file, so only a same-key restart replaces
    // anything; starting a *different* flow abandons nothing to report.
    if (replaced) {
      // Only claim the file was reset when this process reset it: in client mode
      // truncation waits on the client applying the directive, and a rejected
      // path or a failed write there comes back as `savedTo: null`.
      const reset =
        persist === "host"
          ? `${filePath} reset to an empty flow.`
          : `${filePath} is reset to an empty flow once your client applies \`savedTo\` ` +
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
          requiresNote,
        restarted: true,
        ...(discardedSteps === undefined ? {} : { discardedSteps }),
        flowFile,
        savedTo,
      };
    }

    return {
      message: requiresNote
        ? `Started recording "${params.name}" flow.${requiresNote}`
        : `Started recording "${params.name}" flow`,
      flowFile,
      savedTo,
    };
  },
};
