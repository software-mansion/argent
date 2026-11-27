import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InvokeToolOptions, Registry } from "@argent/registry";
import type { AXServiceApi, AXTreeNode, AXTreeResponse } from "../../src/blueprints/ax-service";

// The one seam under the `keyboard` tool: the keys that reach the simulator.
// Everything above it is real, so the text arrives here resolved, as the app
// gets it.
vi.mock("../../src/tools/keyboard/simulator-server-keys", () => ({
  typeSimulatorServer: vi.fn(async (_registry: unknown, _device: unknown, params: KeyParams) => {
    if (params.text !== undefined) app.type(params.text);
    return { typed: params.text ?? params.key ?? "", keys: 1 };
  }),
}));
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  isTvOsSimulator: vi.fn(async () => false),
}));
vi.mock("../../src/utils/check-deps", () => ({ ensureDeps: vi.fn(async () => {}) }));

import {
  createRunFlowTool,
  type FlowRunResult,
  type StepReport,
} from "../../src/tools/flows/flow-run";
import { createKeyboardTool } from "../../src/tools/keyboard";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import {
  __resetTypedSecretsForTesting,
  noteTypedSecrets,
  redactTypedSecrets,
  WITHHELD_INPUT_TEXT,
} from "../../src/utils/typed-secrets";

// A field that is not secure shows what a step typed into it, so the tree a
// `text` check reads holds the value of a `{{secret:…}}` placeholder, in
// whatever form the field gave it, and the reason of a failed check quotes the
// text it read. Nothing between the runner and the screen is mocked: the real
// `keyboard` tool resolves the placeholder, and the runner reads the simulator's
// accessibility tree through the real fetchFlowTree and adapters. The app below
// is the screen: a form of text fields.

interface KeyParams {
  text?: string;
  key?: string;
}

interface Field {
  identifier?: string;
  label?: string;
  placeholder?: string;
  secure?: boolean;
  /** The text the field holds. */
  text: string;
  /** Text a view under the field draws, which the field's text then takes in. */
  under?: string;
  /** What the field holds once `typed` went into it. UIKit capitalizes and corrects by default. */
  takes?: (typed: string, held: string) => string;
  /** Whether focus goes to the next field once this one took text, as a full card field does. */
  thenNext?: boolean;
}

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
const TOKEN = "tok-REVIEW-4242";
const PLACEHOLDER = "{{secret:REVIEW_TOKEN}}";

/** The app under test: a form `form` of fields, a title over it and a status line under it. */
const app = {
  title: "Sign in",
  status: undefined as string | undefined,
  fields: [] as Field[],
  /** The field that has focus, by position. */
  focus: 0 as number | undefined,
  /** How many characters the simulator takes before the keys stop arriving. */
  keysArrive: Infinity,
  /** Called with each text the keyboard sends, resolved. */
  onType: (_text: string): void => {},
  type(text: string): void {
    const field = this.focus === undefined ? undefined : this.fields[this.focus];
    const arrived = text.slice(0, this.keysArrive);
    if (field) {
      field.text = field.takes ? field.takes(arrived, field.text) : field.text + arrived;
      if (field.thenNext) this.focus = this.focus! + 1;
    }
    this.onType(text);
    if (arrived.length < text.length) throw new Error("the simulator stopped taking keys");
  },
  reset(): void {
    Object.assign(this, {
      title: "Sign in",
      status: undefined,
      fields: [{ identifier: "plain-field", text: "" }],
      focus: 0,
      keysArrive: Infinity,
      onType: () => {},
    });
  },
};

const SCREEN = { width: 400, height: 800 };

/** A frame in the screen's points, normalized as the accessibility service sends it. */
function at(x: number, y: number, width: number, height: number) {
  return {
    x: x / SCREEN.width,
    y: y / SCREEN.height,
    width: width / SCREEN.width,
    height: height / SCREEN.height,
  };
}

/** The accessibility tree the service serves for the app as it is now. */
function axTree(): AXTreeResponse {
  const nodes: AXTreeNode[] = [];
  const add = (node: Omit<AXTreeNode, "index">): number => {
    nodes.push({ index: nodes.length, ...node });
    return nodes.length - 1;
  };
  const root = add({ label: "App", bundleId: APP });
  const window = add({ parentIndex: root, elementType: 4, frame: at(0, 0, 400, 800) });
  const label = (text: string, identifier: string, y: number) =>
    add({
      parentIndex: window,
      identifier,
      label: text,
      traits: ["staticText"],
      elementType: 48,
      frame: at(20, y, 360, 24),
    });
  label(app.title, "title", 40);
  const form = add({
    parentIndex: window,
    identifier: "form",
    elementType: 1,
    frame: at(0, 90, 400, 60 * app.fields.length),
  });
  app.fields.forEach((field, i) => {
    const y = 100 + i * 60;
    // An empty field answers its placeholder as its value, with `hintShowing`.
    const shown = field.text || field.placeholder;
    const fieldIndex = add({
      parentIndex: form,
      traits: [
        "textEntry",
        ...(field.secure ? ["secureTextEntry"] : []),
        ...(app.focus === i ? ["isEditing"] : []),
      ],
      elementType: field.secure ? 50 : 49,
      frame: at(20, y, 360, 44),
      ...(field.identifier ? { identifier: field.identifier } : {}),
      ...(field.label ? { label: field.label } : {}),
      ...(shown ? { value: shown } : {}),
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(!field.text && field.placeholder ? { hintShowing: true } : {}),
    });
    if (field.under) {
      add({
        parentIndex: fieldIndex,
        label: field.under,
        traits: ["staticText"],
        elementType: 48,
        frame: at(300, y + 10, 70, 24),
      });
    }
  });
  if (app.status) label(app.status, "status", 600);
  return {
    alertVisible: false,
    screenFrame: SCREEN,
    nodes,
    truncated: false,
    foregroundApp: APP,
    interfaceOrientation: "portrait",
    treeVersion: 3,
  };
}

const axApi = { degraded: false, tree: async () => axTree() } as unknown as AXServiceApi;

let tmpDir: string;
let secrets: Map<string, string>;
let progress: StepReport[];

/** One tool-server: the runs of a test share it, as the tests of a directory run do. */
function toolServer() {
  const registry = {
    resolveService: async () => axApi,
    // The runner binds its device into each tool's device argument.
    getTool: (id: string) => ({
      inputSchema: { properties: id === "e2e-execute" ? { device: {} } : { udid: {} } },
    }),
    invokeTool: vi.fn(async (id: string, args: unknown, options?: InvokeToolOptions) => {
      if (id === "keyboard") return keyboard.execute({}, args as never, options as never);
      if (id === "e2e-execute") return runTool.execute({}, args as never, options as never);
      // A tap gives focus to the field under it, and a `run-sequence` runs its steps in order.
      if (id === "gesture-tap") {
        const at = (args as { y: number }).y * 800;
        const tapped = app.fields.findIndex((_, i) => at >= 100 + i * 60 && at < 144 + i * 60);
        if (tapped >= 0) app.focus = tapped;
      }
      if (id === "run-sequence") {
        const { udid, steps } = args as {
          udid: string;
          steps: Array<{ tool: string; args: object }>;
        };
        for (const step of steps) {
          await registry.invokeTool(step.tool, { udid, ...step.args }, options);
        }
      }
      return { ok: true };
    }),
  } as unknown as Registry;
  const keyboard = createKeyboardTool(registry);
  const runTool = createRunFlowTool(registry);
  return runTool;
}

type Steps = Parameters<typeof serializeFlow>[0]["steps"];

async function writeTest(name: string, steps: Steps): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
}

/** Longest a run may take in real time. Far more than one needs: they take milliseconds. */
const RUN_BUDGET_MS = 4_000;

/**
 * Run an e2e test on a clock the test turns: a `type` step waits for focus to
 * settle and a failing `assert` for its grace period, and neither wait is what
 * these tests are about.
 *
 * The clock is turned until the run settles, however long that takes in real
 * time. A run also does work that no timer drives, such as reading its file,
 * and a count of turns would give up while a slow read is still out: the run
 * then parks on a timer that nobody advances, and the test times out.
 */
async function execute(
  server: ReturnType<typeof toolServer>,
  name: string
): Promise<FlowRunResult> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const pending = server.execute({}, { name, project_root: tmpDir, device: DEVICE }, {
      clientSecrets: secrets,
      emitProgress: (report: StepReport) => progress.push(structuredClone(report)),
    } as never);
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    const giveUp = performance.now() + RUN_BUDGET_MS;
    while (!settled) {
      if (performance.now() > giveUp) throw new Error(`the run of "${name}" did not settle`);
      // Let work that is not a timer make progress, then move the timers on,
      // if the run waits on one: its deadlines must not pass during a read.
      await new Promise((resolve) => setImmediate(resolve));
      if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(250);
    }
    const result = await pending;
    if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
    return result;
  } finally {
    vi.useRealTimers();
  }
}

async function run(steps: Steps): Promise<FlowRunResult> {
  await writeTest("token", steps);
  return execute(toolServer(), "token");
}

function typeToken(text = PLACEHOLDER, into = "plain-field") {
  return { kind: "type", into: { identifier: into }, text, submit: false } as const;
}

/** A check that fails, and so quotes the text of its element. */
function saved(identifier = "plain-field", expectedText = "Saved") {
  return {
    kind: "assert",
    condition: "text",
    selector: { identifier },
    expectedText,
    textMatch: "contains",
  } as const;
}

function reasonOf(result: FlowRunResult): string | undefined {
  return result.steps.find((s) => s.status === "fail")?.reason;
}

/** The reason of a failed `contains` check on `id` that read `text`. */
function reason(id: string, text: string, wanted = "Saved"): string {
  return `element matched id="${id}" but its text was "${text}" (wanted to contain "${wanted}")`;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-secret-reason-"));
  secrets = new Map([["REVIEW_TOKEN", TOKEN]]);
  progress = [];
  app.reset();
  __resetTypedSecretsForTesting();
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a device on which no secret was typed", () => {
  it("has the text a field holds quoted as it is", async () => {
    app.fields = [
      { identifier: "plain-field", label: "Name", text: "linda" },
      { label: "City", text: "Oslo" },
    ];

    expect(reasonOf(await run([saved()]))).toBe(reason("plain-field", "Name linda"));
    // A field with an identifier keeps its text to itself; the other one's is the form's.
    expect(reasonOf(await run([saved("form")]))).toBe(reason("form", "City Oslo"));
  });

  it("has it quoted while a secret was typed on a different device", async () => {
    noteTypedSecrets("11111111-0000-0000-0000-0000000000cd", [
      { name: "REVIEW_TOKEN", value: TOKEN },
    ]);
    app.fields[0]!.text = TOKEN;

    expect(reasonOf(await run([saved()]))).toBe(reason("plain-field", TOKEN));
  });
});

describe("the text of a text input once a secret was typed on the device", () => {
  it("is withheld from the reason of a failed check", async () => {
    const result = await run([typeToken(), saved()]);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass", "assert:fail"]);
    expect(app.fields[0]!.text).toBe(TOKEN);
    expect(reasonOf(result)).toBe(
      'element matched id="plain-field" but its text was ' +
        '"[text withheld: a secret was typed on this device]" (wanted to contain "Saved")'
    );
    // Nothing the run returns or streams holds the value.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(progress)).not.toContain(TOKEN);
  });

  it("is still what a check reads", async () => {
    app.fields[0]!.takes = () => "Too-REVIEW-4242";
    const result = await run([typeToken(), saved("plain-field", "Too-REVIEW")]);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass", "assert:pass"]);
  });

  it("is withheld whatever the field made of the value", async () => {
    // UIKit's default traits: a capital first letter, then a correction.
    for (const shown of ["Tok-REVIEW-4242", "Too-REVIEW-4242"]) {
      app.reset();
      app.fields[0]!.takes = () => shown;
      const result = await run([typeToken(), saved()]);

      expect(app.fields[0]!.text).toBe(shown);
      expect(reasonOf(result)).toBe(reason("plain-field", WITHHELD_INPUT_TEXT));
      expect(JSON.stringify(result)).not.toContain("REVIEW-4242");
    }
  });

  it("is withheld beside a label that no lowercase form keeps the length of", async () => {
    // "İ" lowercases to two characters and "Σ" to one of two letters: nothing
    // here compares text without regard to case, so neither matters.
    for (const name of ["İsim", "ΣΎΝΟΛΟ Σ"]) {
      app.reset();
      app.fields[0]!.label = name;
      const result = await run([typeToken(), saved()]);

      expect(reasonOf(result)).toBe(reason("plain-field", `${name} ${WITHHELD_INPUT_TEXT}`));
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it("is withheld from the text of a view around the field, and its label is not", async () => {
    app.fields = [
      { label: "Token", text: "" },
      { label: "Note", text: "for linda" },
    ];
    const result = await run([
      { kind: "tool", name: "keyboard", args: { text: PLACEHOLDER } },
      saved("form"),
    ]);

    // Every text input, not only the one that took the secret.
    expect(reasonOf(result)).toBe(
      reason("form", `Token ${WITHHELD_INPUT_TEXT} Note ${WITHHELD_INPUT_TEXT}`)
    );
  });

  it("is withheld from the field's own text and from the text it takes in from under it", async () => {
    app.fields[0]!.label = "Token";
    app.fields[0]!.under = "4 of 16";
    const result = await run([typeToken(), saved()]);

    expect(reasonOf(result)).toBe(
      `element matched id="plain-field" but its text was "Token ${WITHHELD_INPUT_TEXT} 4 of 16" ` +
        `(own text "Token ${WITHHELD_INPUT_TEXT}") (wanted to contain "Saved")`
    );
  });

  it("is withheld for a card number that the field formatted while focus moved on", async () => {
    // Neither field has an identifier, and the second one has focus by the
    // time anything could look at the first: nothing here follows the secret.
    secrets.set("CARD", "4242424242424242");
    app.fields = [
      { label: "Card", text: "", takes: () => "4242 4242 4242 4242", thenNext: true },
      { label: "Expiry", placeholder: "MM/YY", text: "" },
    ];
    app.status = "Format: MM/YY";
    const result = await run([
      { kind: "tool", name: "keyboard", args: { text: "{{secret:CARD}}" } },
      saved("form"),
    ]);

    expect(app.focus).toBe(1);
    expect(reasonOf(result)).toBe(
      reason("form", `Card ${WITHHELD_INPUT_TEXT} Expiry ${WITHHELD_INPUT_TEXT}`)
    );
    expect(JSON.stringify(result)).not.toContain("4242");
    // The placeholder of the next field is not a secret from now on: text that
    // is no text input's still shows it.
    expect(redactTypedSecrets(DEVICE, "MM/YY")).toBe("MM/YY");
    expect(reasonOf(await run([saved("status")]))).toBe(reason("status", "Format: MM/YY"));
  });

  it("is withheld for a field that a `run-sequence` gave focus and typed into", async () => {
    // Focus is on the first field until the sequence taps the second.
    app.fields = [
      { identifier: "name", text: "linda" },
      { identifier: "token", text: "", takes: () => "Too-REVIEW-4242" },
    ];
    const result = await run([
      {
        kind: "tool",
        name: "run-sequence",
        args: {
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.225 } },
            { tool: "keyboard", args: { text: PLACEHOLDER } },
          ],
        },
      },
      saved("token"),
    ]);

    expect(app.fields.map((f) => f.text)).toEqual(["linda", "Too-REVIEW-4242"]);
    expect(reasonOf(result)).toBe(reason("token", WITHHELD_INPUT_TEXT));
  });

  it("is withheld when the step that typed the secret failed partway", async () => {
    app.keysArrive = 9;
    const server = toolServer();
    await writeTest("01-type", [typeToken()]);
    await writeTest("02-check", [saved()]);

    const typed = await execute(server, "01-type");
    expect(typed.steps[0]!.status).toBe("error");
    expect(app.fields[0]!.text).toBe("tok-REVIE");
    const check = await execute(server, "02-check");

    expect(reasonOf(check)).toBe(reason("plain-field", WITHHELD_INPUT_TEXT));
    expect(JSON.stringify([typed, check, progress])).not.toContain("tok-REVIE");
  });

  it.each([
    ["a `launch` step", { kind: "launch", app: APP }],
    ["a `tool: restart-app` step", { kind: "tool", name: "restart-app", args: { bundleId: APP } }],
  ] as const)("stays withheld after %s starts the app again", async (_, start) => {
    const server = toolServer();
    await writeTest("01-type", [typeToken()]);
    await writeTest("02-check", [start, saved()]);
    await execute(server, "01-type");
    // An app that kept what the field showed.
    app.fields[0]!.text = "Too-REVIEW-4242";

    expect(reasonOf(await execute(server, "02-check"))).toBe(
      reason("plain-field", WITHHELD_INPUT_TEXT)
    );
  });

  it("is withheld for an empty field too, whose placeholder is its value on this tree", async () => {
    app.fields.push({ identifier: "search", placeholder: "Search", text: "" });

    expect(reasonOf(await run([typeToken(), saved("search")]))).toBe(
      reason("search", WITHHELD_INPUT_TEXT)
    );
  });

  it("leaves a secure field, whose text was never read, as empty as it was", async () => {
    app.fields[0]!.secure = true;
    const result = await run([typeToken(), saved()]);

    expect(app.fields[0]!.text).toBe(TOKEN);
    expect(reasonOf(result)).toBe(
      'element matched id="plain-field", but it is a password field. An e2e test does not read ' +
        'the text of a password field (wanted to contain "Saved").'
    );
  });
});

// The check that fails is often not in the run that typed: the later e2e tests
// of a directory run are fragments on the device as the earlier ones left it,
// and a nested run is a run of its own.
describe("a secret that a different run typed", () => {
  it("is not quoted by a later e2e test on the same device", async () => {
    const server = toolServer();
    await writeTest("01-type", [typeToken()]);
    await writeTest("02-check", [saved()]);

    expect((await execute(server, "01-type")).ok).toBe(true);
    const check = await execute(server, "02-check");

    expect(reasonOf(check)).toBe(reason("plain-field", WITHHELD_INPUT_TEXT));
    expect(JSON.stringify(check)).not.toContain(TOKEN);
    expect(JSON.stringify(progress)).not.toContain(TOKEN);
  });

  it("is not quoted by the run around the nested run that typed it", async () => {
    await writeTest("typing", [typeToken()]);

    const result = await run([
      { kind: "tool", name: "e2e-execute", args: { name: "typing", project_root: tmpDir } },
      saved(),
    ]);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:pass", "assert:fail"]);
    expect(reasonOf(result)).toBe(reason("plain-field", WITHHELD_INPUT_TEXT));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("is not quoted by a nested run when the run around it typed", async () => {
    await writeTest("checking", [saved()]);

    const result = await run([
      typeToken(),
      { kind: "tool", name: "e2e-execute", args: { name: "checking", project_root: tmpDir } },
    ]);

    // The nested report is the result of the step, and its reason the step's.
    expect(result.steps[1]!.status).toBe("fail");
    expect(JSON.stringify(result.steps[1])).toContain(WITHHELD_INPUT_TEXT);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(progress)).not.toContain(TOKEN);
  });
});

// Text that is no text input's is still quoted. There a value is replaced where
// the screen shows it as it was typed, and nowhere else.
describe("a typed value in text that is no text input's", () => {
  it("is named by its placeholder where the app shows it as typed", async () => {
    app.status = `Signed in with ${TOKEN}`;
    const result = await run([typeToken(), saved("status")]);

    expect(reasonOf(result)).toBe(reason("status", `Signed in with ${PLACEHOLDER}`));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("is found beside and inside text that has no simple lowercase form", async () => {
    secrets.set("REVIEW_TOKEN", "Σ-κλειδί-İ9");
    app.status = "İsim: Σ-κλειδί-İ9 Σ";
    const result = await run([typeToken(), saved("status")]);

    expect(reasonOf(result)).toBe(reason("status", `İsim: ${PLACEHOLDER} Σ`));
  });

  it("leaves the wording of the reason and the expected text as the author wrote them", async () => {
    secrets.set("REVIEW_TOKEN", "e");
    app.fields[0]!.label = "Enter the code";
    const result = await run([typeToken(), saved("plain-field", "Saved element")]);

    expect(app.fields[0]!.text).toBe("e");
    // Every "e" of the label goes, and not its "E". None goes from the note,
    // the wording or the expected text: only text off the screen is searched.
    expect(reasonOf(result)).toBe(
      'element matched id="plain-field" but its text was ' +
        `"Ent${PLACEHOLDER}r th${PLACEHOLDER} cod${PLACEHOLDER} ` +
        '[text withheld: a secret was typed on this device]" (wanted to contain "Saved element")'
    );
  });

  it("leaves a reason that quotes no screen text alone", async () => {
    secrets.set("REVIEW_TOKEN", "e");
    const result = await run([
      typeToken(),
      { kind: "assert", condition: "visible", selector: { identifier: "elsewhere" } },
    ]);

    // The reason is the runner's wording alone, with every "e" kept.
    const reason = reasonOf(result)!;
    expect(reason).toMatch(
      /^no visible element matched selector id="elsewhere", and no element with this id is in the accessibility tree right now/
    );
    expect(reason).not.toContain(PLACEHOLDER);
  });

  it("is named for both values of a name that resolved to a second one", async () => {
    // The secrets file changed between the two steps.
    app.onType = () => secrets.set("REVIEW_TOKEN", "second-VALUE-99");
    app.status = `${TOKEN} then second-VALUE-99`;
    const result = await run([typeToken(), typeToken(), saved("status")]);

    expect(app.fields[0]!.text).toBe(`${TOKEN}second-VALUE-99`);
    expect(reasonOf(result)).toBe(reason("status", `${PLACEHOLDER} then ${PLACEHOLDER}`));
  });
});
