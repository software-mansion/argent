import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import {
  createRunFlowTool,
  type FlowRunResult,
  type StepReport,
} from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";

// A field that is not secure shows what a step typed into it, so the tree a
// `text` check reads holds the value of a `{{secret:…}}` placeholder, and the
// reason of a failed check quotes the text it read. Nothing on the tree path is
// mocked: the runner goes through the real fetchFlowTree and the simulator
// adapter, over a native-devtools API that serves the hierarchy below.

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
const TOKEN = "tok-REVIEW-4242";
let tmpDir: string;

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

/** One screen: a text field `plain-field`, focused, that holds `text`. */
function nativeApi(field: Record<string, unknown>): NativeDevtoolsApi {
  const screen = { x: 0, y: 0, width: 400, height: 800 };
  return {
    listConnectedBundleIds: () => [APP],
    getAppState: async (id: string) => appState(id),
    queryViewHierarchy: async () => ({
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
                  firstResponder: true,
                  screenFrame: { x: 20, y: 100, width: 360, height: 44 },
                  children: [],
                  ...field,
                },
              ],
            },
          ],
        },
      ],
    }),
  } as unknown as NativeDevtoolsApi;
}

function mockRegistry(api: NativeDevtoolsApi): Registry {
  return {
    resolveService: async () => api,
    invokeTool: vi.fn(async () => ({ ok: true })),
    getTool: () => undefined,
  } as unknown as Registry;
}

async function run(
  field: Record<string, unknown>,
  steps: Parameters<typeof serializeFlow>[0]["steps"],
  secrets: Record<string, string> = { REVIEW_TOKEN: TOKEN }
): Promise<{ result: FlowRunResult; progress: StepReport[] }> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "token.yaml"),
    serializeFlow({ executionPrerequisite: "", steps }),
    "utf8"
  );
  const progress: StepReport[] = [];
  const result = await createRunFlowTool(mockRegistry(nativeApi(field))).execute(
    {},
    { name: "token", project_root: tmpDir, device: DEVICE },
    {
      clientSecrets: new Map(Object.entries(secrets)),
      emitProgress: (report: StepReport) => progress.push(structuredClone(report)),
    } as never
  );
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return { result, progress };
}

const TYPE_TOKEN = {
  kind: "type",
  into: { identifier: "plain-field" },
  text: "{{secret:REVIEW_TOKEN}}",
  submit: false,
} as const;

const SAVED = {
  kind: "assert",
  condition: "text",
  selector: { identifier: "plain-field" },
  expectedText: "Saved",
  textMatch: "contains",
} as const;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-secret-reason-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a typed secret in the reason of a failed text check", () => {
  it("shows the placeholder, not the value the field holds", async () => {
    const { result, progress } = await run({ identifier: "plain-field", value: TOKEN }, [
      TYPE_TOKEN,
      SAVED,
    ]);

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["type:pass", "assert:fail"]);
    expect(result.steps[1]!.reason).toBe(
      'element matched id="plain-field" but its text was "{{secret:REVIEW_TOKEN}}" ' +
        '(wanted to contain "Saved")'
    );
    // Nothing the run returns or streams holds the value.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(progress)).not.toContain(TOKEN);
  });

  it("replaces the value inside the text of a view around the field", async () => {
    // The field has no identifier here, so the row around it reads its text.
    const { result } = await run({ label: "Token", value: TOKEN }, [
      { kind: "tool", name: "keyboard", args: { text: "{{secret:REVIEW_TOKEN}}" } },
      { ...SAVED, selector: { identifier: "token-row" } },
    ]);

    expect(result.steps[1]!.reason).toContain('its text was "Token {{secret:REVIEW_TOKEN}}"');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("replaces the value in a step of a `run:` fragment that an earlier step typed", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "check.yaml"),
      serializeFlow({ executionPrerequisite: "The token is typed", steps: [SAVED] }),
      "utf8"
    );

    const { result } = await run({ identifier: "plain-field", value: TOKEN }, [
      TYPE_TOKEN,
      { kind: "run", flow: "check.yaml" },
    ]);

    const failed = result.steps.find((s) => s.status === "fail");
    expect(failed?.reason).toContain('its text was "{{secret:REVIEW_TOKEN}}"');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("leaves the text of a run that typed no secret as it is", async () => {
    const { result } = await run({ identifier: "plain-field", value: TOKEN }, [SAVED]);

    expect(result.steps[0]!.reason).toContain(`its text was "${TOKEN}"`);
  });

  it("keeps the reason when no source defines the secret a step names", async () => {
    const { result } = await run(
      { identifier: "plain-field", value: "linda" },
      [
        { kind: "tool", name: "gesture-tap", args: { x: 0.5, y: 0.5, note: "{{secret:NOPE}}" } },
        SAVED,
      ],
      {}
    );

    expect(result.steps[1]!.reason).toContain('its text was "linda"');
  });
});
