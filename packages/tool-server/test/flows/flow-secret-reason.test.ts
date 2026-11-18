import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InvokeToolOptions, Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";

// The one seam under the `keyboard` tool: the keys that reach the simulator.
// Everything above it is real, so the text arrives here resolved, as the app
// gets it.
vi.mock("../../src/tools/keyboard/simulator-server-keys", () => ({
  typeSimulatorServer: vi.fn(async (_registry: unknown, _device: unknown, params: KeyParams) => {
    if (params.text !== undefined) app.type(params.text);
    if (params.key !== undefined) app.press(params.key);
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
import { __resetTypedSecretsForTesting } from "../../src/utils/typed-secrets";

// A field that is not secure shows what a step typed into it, so the tree a
// `text` check reads holds the value of a `{{secret:…}}` placeholder, and the
// reason of a failed check quotes the text it read. Nothing between the runner
// and the screen is mocked: the real `keyboard` tool resolves the placeholder,
// and the runner reads the simulator hierarchy through the real fetchFlowTree
// and adapter. The app below is the screen: one text field in a row.

interface KeyParams {
  text?: string;
  key?: string;
}

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
const TOKEN = "tok-REVIEW-4242";
const PLACEHOLDER = "{{secret:REVIEW_TOKEN}}";

/** The app under test. A test sets how its field treats what it gets. */
const app = {
  identifier: "plain-field" as string | undefined,
  label: undefined as string | undefined,
  placeholder: undefined as string | undefined,
  secure: false,
  /** The text the field holds. */
  text: "",
  /** Whether the field reports that it has focus. */
  focused: true,
  /** Text a view under the field draws, which the field's text then takes in. */
  hint: undefined as string | undefined,
  /** What the field makes of typed text: UIKit capitalizes and corrects by default. */
  shows: (typed: string): string => typed,
  /** What a key does to the text the field holds. */
  onKey: (_key: string, text: string): string => text,
  /** Called with each text the keyboard sends, resolved. */
  onType: (_text: string): void => {},
  type(text: string): void {
    this.text += this.shows(text);
    this.onType(text);
  },
  press(key: string): void {
    this.text = this.onKey(key, this.text);
  },
  reset(): void {
    Object.assign(this, {
      identifier: "plain-field",
      label: undefined,
      placeholder: undefined,
      secure: false,
      text: "",
      focused: true,
      hint: undefined,
      shows: (typed: string) => typed,
      onKey: (_key: string, text: string) => text,
      onType: () => {},
    });
  },
};

function appState(bundleId: string): NativeAppState {
  return {
    bundleId,
    applicationState: "active",
    foregroundActiveSceneCount: 1,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: 0,
    unattachedSceneCount: 0,
    isFrontmostCandidate: true,
  };
}

/** The hierarchy the framework serves for the app as it is now. */
function hierarchy(): unknown {
  const screen = { x: 0, y: 0, width: 400, height: 800 };
  // UIKit reports the placeholder as the value of an empty field, and the
  // framework serves no value for a secure one.
  const value = app.secure ? undefined : app.text || app.placeholder;
  return {
    screen: { width: 400, height: 800 },
    windows: [
      {
        className: "UIWindow",
        screenFrame: screen,
        children: [
          {
            className: "UIView",
            identifier: "token-row",
            screenFrame: { x: 0, y: 80, width: 400, height: 84 },
            children: [
              {
                className: "UITextField",
                ...(app.focused ? { firstResponder: true } : {}),
                screenFrame: { x: 20, y: 100, width: 360, height: 44 },
                children: [
                  // As in UIKit: the editor under a field that has focus says
                  // it is the first responder too, and holds none of its text.
                  ...(app.focused
                    ? [
                        {
                          className: "UIFieldEditor",
                          firstResponder: true,
                          screenFrame: { x: 27, y: 102, width: 346, height: 40 },
                          children: [],
                        },
                      ]
                    : []),
                  ...(app.hint
                    ? [
                        {
                          className: "UILabel",
                          label: app.hint,
                          screenFrame: { x: 300, y: 110, width: 70, height: 24 },
                          children: [],
                        },
                      ]
                    : []),
                ],
                ...(app.identifier ? { identifier: app.identifier } : {}),
                ...(app.label ? { label: app.label } : {}),
                ...(value ? { value } : {}),
              },
            ],
          },
        ],
      },
    ],
  };
}

const nativeApi = {
  listConnectedBundleIds: () => [APP],
  isConnected: () => true,
  getAppState: async (id: string) => appState(id),
  queryViewHierarchy: async () => hierarchy(),
} as unknown as NativeDevtoolsApi;

let tmpDir: string;
let secrets: Map<string, string>;
let progress: StepReport[];

/** One tool-server: the runs of a test share it, as the tests of a directory run do. */
function toolServer({ tapFocuses } = { tapFocuses: true }) {
  const registry = {
    resolveService: async () => nativeApi,
    // The runner binds its device into each tool's device argument.
    getTool: (id: string) => ({
      inputSchema: { properties: id === "e2e-execute" ? { device: {} } : { udid: {} } },
    }),
    invokeTool: vi.fn(async (id: string, args: unknown, options?: InvokeToolOptions) => {
      if (id === "keyboard") return keyboard.execute({}, args as never, options as never);
      if (id === "e2e-execute") return runTool.execute({}, args as never, options as never);
      // A tap gives the field focus, and a `run-sequence` runs its steps in order.
      if (id === "gesture-tap" && tapFocuses) app.focused = true;
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

/**
 * Run an e2e test on a clock the test turns: a `type` step waits for focus to
 * settle and a failing `assert` for its grace period, and neither wait is what
 * these tests are about.
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
    for (let i = 0; i < 400 && !settled; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(250);
    }
    const result = await pending;
    if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
    return result;
  } finally {
    vi.useRealTimers();
  }
}

async function run(steps: Steps, options?: { tapFocuses: boolean }): Promise<FlowRunResult> {
  await writeTest("token", steps);
  return execute(toolServer(options), "token");
}

function typeToken(text = PLACEHOLDER, submit = false) {
  return { kind: "type", into: { identifier: "token-row" }, text, submit } as const;
}

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

describe("a typed secret in the reason of a failed text check", () => {
  it("shows the placeholder, not the value the field holds", async () => {
    const result = await run([typeToken(), saved()]);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass", "assert:fail"]);
    expect(app.text).toBe(TOKEN);
    expect(reasonOf(result)).toBe(
      `element matched id="plain-field" but its text was "${PLACEHOLDER}" ` +
        '(wanted to contain "Saved")'
    );
    // Nothing the run returns or streams holds the value.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(progress)).not.toContain(TOKEN);
  });

  it("replaces the value inside the text of a view around the field", async () => {
    // The field has no identifier here, so the row around it reads its text.
    app.identifier = undefined;
    app.label = "Token";
    const result = await run([
      { kind: "tool", name: "keyboard", args: { text: PLACEHOLDER } },
      saved("token-row"),
    ]);

    expect(reasonOf(result)).toContain(`its text was "Token ${PLACEHOLDER}"`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("replaces the value in a step of a `run:` fragment that an earlier step typed", async () => {
    await writeTest("check", [saved()]);

    const result = await run([typeToken(), { kind: "run", flow: "check.yaml" }]);

    expect(reasonOf(result)).toContain(`its text was "${PLACEHOLDER}"`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("replaces the value in the field's own text and in the text it takes in from under it", async () => {
    app.hint = "4 of 16";
    const result = await run([typeToken(), saved()]);

    expect(reasonOf(result)).toBe(
      `element matched id="plain-field" but its text was "${PLACEHOLDER} 4 of 16" ` +
        `(own text "${PLACEHOLDER}") (wanted to contain "Saved")`
    );
  });

  it("leaves the text of a device that no secret was typed on as it is", async () => {
    app.text = TOKEN;
    const result = await run([saved()]);

    expect(reasonOf(result)).toContain(`its text was "${TOKEN}"`);
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

    expect(reasonOf(check)).toBe(
      `element matched id="plain-field" but its text was "${PLACEHOLDER}" ` +
        '(wanted to contain "Saved")'
    );
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
    expect(reasonOf(result)).toContain(`its text was "${PLACEHOLDER}"`);
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
    expect(JSON.stringify(result.steps[1])).toContain(`its text was \\"${PLACEHOLDER}\\"`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(progress)).not.toContain(TOKEN);
  });
});

// A UITextField with UIKit's default traits capitalizes the first letter and
// corrects what it takes for a word, so the field does not show the value.
describe("a field that changes the secret typed into it", () => {
  const SHOWN = "Too-REVIEW-4242";

  it("does not quote the text the field made of the value", async () => {
    app.shows = () => SHOWN;
    const result = await run([typeToken(), saved()]);

    expect(app.text).toBe(SHOWN);
    expect(reasonOf(result)).toBe(
      `element matched id="plain-field" but its text was "${PLACEHOLDER}" ` +
        '(wanted to contain "Saved")'
    );
    expect(JSON.stringify(result)).not.toContain("REVIEW-4242");
  });

  it("reads the field back for a bare keyboard step, and without an identifier", async () => {
    app.identifier = undefined;
    app.label = "Token";
    app.shows = () => SHOWN;
    const result = await run([
      { kind: "tool", name: "keyboard", args: { text: `id-${PLACEHOLDER}` } },
      saved("token-row"),
    ]);

    // The step's own text stands in for what the field made of it.
    expect(reasonOf(result)).toContain(`its text was "Token id-${PLACEHOLDER}"`);
    expect(JSON.stringify(result)).not.toContain("REVIEW-4242");
  });

  it("does not quote it in a later e2e test either", async () => {
    app.shows = () => SHOWN;
    const server = toolServer();
    await writeTest("01-type", [typeToken()]);
    await writeTest("02-check", [saved()]);

    await execute(server, "01-type");
    const check = await execute(server, "02-check");

    expect(reasonOf(check)).toContain(`its text was "${PLACEHOLDER}"`);
    expect(JSON.stringify(check)).not.toContain("REVIEW-4242");
  });

  it("reads the field again after the Enter of a submit", async () => {
    // The field accepts a correction of its last word on return.
    app.shows = () => "Tok-REVIEW-4242";
    app.onKey = (key, text) => (key === "enter" ? "Tok-REVIEW-4243" : text);
    const result = await run([typeToken(PLACEHOLDER, true), saved()]);

    expect(app.text).toBe("Tok-REVIEW-4243");
    expect(reasonOf(result)).toContain(`its text was "${PLACEHOLDER}"`);
  });

  it("withholds the text of the field when it changed after the step read it", async () => {
    app.label = "Token";
    app.shows = () => SHOWN;
    const server = toolServer();
    await writeTest("01-type", [typeToken()]);
    await writeTest("02-check", [saved()]);
    await execute(server, "01-type");
    // What a field does when it loses focus: one more correction.
    app.text = "Too-REVIEW-4243";

    const check = await execute(server, "02-check");

    expect(reasonOf(check)).toBe(
      'element matched id="plain-field" but its text was ' +
        `"Token [withheld: a step typed ${PLACEHOLDER} into this field]" ` +
        '(wanted to contain "Saved")'
    );
    expect(JSON.stringify(check)).not.toContain("REVIEW-424");
  });

  it("quotes the field again when it holds what it held before the secret", async () => {
    app.placeholder = "Search";
    const server = toolServer();
    await writeTest("01-type", [typeToken()]);
    await writeTest("02-check", [saved()]);
    await execute(server, "01-type");
    app.text = "";

    expect(reasonOf(await execute(server, "02-check"))).toContain('its text was "Search"');
  });

  it.each([
    ["a `launch` step", { kind: "launch", app: APP }],
    ["a `tool: restart-app` step", { kind: "tool", name: "restart-app", args: { bundleId: APP } }],
  ] as const)("forgets the field when %s starts the app again, not the value", async (_, start) => {
    app.shows = () => SHOWN;
    const server = toolServer();
    await writeTest("01-type", [typeToken()]);
    await writeTest("02-check", [start, saved()]);
    await execute(server, "01-type");

    // A new start of the app, and text in the field that is no secret.
    app.text = "linda";
    expect(reasonOf(await execute(server, "02-check"))).toContain('its text was "linda"');
    // An app that restored what the field showed still has it replaced.
    app.text = SHOWN;
    expect(reasonOf(await execute(server, "02-check"))).toContain(`its text was "${PLACEHOLDER}"`);
  });

  it("keeps the field after a `tool: launch-app` step, which only brings the app forward", async () => {
    app.shows = () => SHOWN;
    const server = toolServer();
    await writeTest("01-type", [typeToken()]);
    await writeTest("02-check", [
      { kind: "tool", name: "launch-app", args: { bundleId: APP } },
      saved(),
    ]);
    await execute(server, "01-type");
    app.text = "Too-REVIEW-4243";

    expect(reasonOf(await execute(server, "02-check"))).toContain("[withheld: a step typed");
  });

  it("reads the element under the tap where nothing reports focus", async () => {
    app.focused = false;
    app.shows = () => SHOWN;
    // The tap of the `type` step gives no focus that the tree reports.
    const result = await run([typeToken(), saved()], { tapFocuses: false });

    expect(reasonOf(result)).toContain(`its text was "${PLACEHOLDER}"`);
  });

  it("withholds the text of a field that a `run-sequence` focused and typed into", async () => {
    // Nothing had focus before the step, so there is no earlier text to tell
    // what the step added: the field is noted, and its text is not.
    app.focused = false;
    app.shows = () => SHOWN;
    const result = await run([
      {
        kind: "tool",
        name: "run-sequence",
        args: {
          steps: [
            { tool: "gesture-tap", args: { x: 0.5, y: 0.15 } },
            { tool: "keyboard", args: { text: PLACEHOLDER } },
          ],
        },
      },
      saved(),
    ]);

    expect(app.text).toBe(SHOWN);
    expect(reasonOf(result)).toContain(
      `its text was "[withheld: a step typed ${PLACEHOLDER} into this field]"`
    );
  });

  it("leaves text the field already held out of what it notes for the secret", async () => {
    // Without an identifier nothing says later which field this was, so what
    // the step added is all that stands for the secret.
    app.identifier = undefined;
    app.label = "Token";
    app.text = "id-";
    app.shows = () => SHOWN;
    const result = await run([
      { kind: "tool", name: "keyboard", args: { text: PLACEHOLDER } },
      saved("token-row"),
    ]);

    expect(reasonOf(result)).toContain(`its text was "Token id-${PLACEHOLDER}"`);
  });

  it("takes nothing from a secure field, whose text it cannot read", async () => {
    app.secure = true;
    app.identifier = "plain-field";
    const result = await run([typeToken(), saved()]);

    expect(app.text).toBe(TOKEN);
    expect(reasonOf(result)).toContain('its text was ""');
  });

  it("does not take a placeholder for the secret when the typing did not land", async () => {
    app.placeholder = "Search";
    app.shows = () => "";
    const result = await run([typeToken(), saved(), saved()]);

    expect(reasonOf(result)).toContain('its text was "Search"');
  });
});

describe("a short secret value", () => {
  it("leaves the wording of the reason and the expected text as the author wrote them", async () => {
    secrets.set("REVIEW_TOKEN", "e");
    app.label = "Enter the code";
    const result = await run([typeToken(), saved("plain-field", "Saved element")]);

    expect(app.text).toBe("e");
    // Only the text read off the screen is searched, and there every "e" goes.
    expect(reasonOf(result)).toBe(
      'element matched id="plain-field" but its text was ' +
        `"${PLACEHOLDER}nt${PLACEHOLDER}r th${PLACEHOLDER} cod${PLACEHOLDER} ${PLACEHOLDER}" ` +
        '(wanted to contain "Saved element")'
    );
  });

  it("leaves a reason that quotes no screen text alone", async () => {
    secrets.set("REVIEW_TOKEN", "e");
    const result = await run([
      typeToken(),
      { kind: "assert", condition: "visible", selector: { identifier: "elsewhere" } },
    ]);

    expect(reasonOf(result)).toBe('no element matched selector id="elsewhere"');
  });
});

describe("a secret name that resolves to a second value", () => {
  it("replaces both values, the one typed first too", async () => {
    // The secrets file changed between the two steps.
    app.onType = () => secrets.set("REVIEW_TOKEN", "second-VALUE-99");
    const result = await run([typeToken(), typeToken(), saved()]);

    expect(app.text).toBe(`${TOKEN}second-VALUE-99`);
    expect(reasonOf(result)).toContain(`its text was "${PLACEHOLDER}${PLACEHOLDER}"`);
    expect(JSON.stringify(result)).not.toContain("REVIEW-4242");
    expect(JSON.stringify(result)).not.toContain("VALUE-99");
  });
});
