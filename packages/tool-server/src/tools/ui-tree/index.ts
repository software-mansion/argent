import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import type { DescribeFrame, DescribeNode } from "../describe/contract";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../utils/capability";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { iosRequires } from "../describe/platforms/ios";
import { androidRequires } from "../describe/platforms/android";
import { readIosUiTree } from "./ios";
import { readAndroidUiTree } from "./android";

// The raw, unpruned tree for SDK callers (e2e-argent). Mirrored, with field
// docs, in argent/src/client.ts; a rename, removal or meaning change bumps
// `schemaVersion`, an added optional field does not.
export type UiTreeNode = Pick<
  DescribeNode,
  | "role"
  | "label"
  | "value"
  | "identifier"
  | "checked"
  | "disabled"
  | "password"
  | "focused"
  | "selected"
> & {
  frame?: DescribeFrame;
  type?: string;
  traits?: string[];
  roleDescription?: string;
  contentDescription?: string;
  bundleId?: string;
  editable?: boolean;
  heading?: boolean;
  covered?: boolean;
  children: UiTreeNode[];
};

export interface UiTree {
  schemaVersion: 1;
  source: "ax-service" | "android-devtools";
  screen?: { width: number; height: number };
  roots: UiTreeNode[];
  truncated: boolean;
  alertVisible?: boolean;
  keyboardVisible?: boolean;
  unsupportedFields: string[];
}

const zodSchema = z.object({
  udid: z.string().min(1).describe("Target device id from `list-devices`."),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export function createUiTreeTool(registry: Registry): ToolDefinition<Params, UiTree> {
  return {
    id: "ui-tree",
    interaction: {
      startedMsg: () => "Reading UI tree",
      completedMsg: () => "Read UI tree",
      failedMsg: ({ failureSignal }) => `Failed to read UI tree: ${failureSignal.error_code}`,
    },
    description: `Read the raw accessibility tree of the screen as nested JSON, for SDK callers.
Use when a program needs element ancestry, such as an e2e engine's scoped selectors; agents use describe.
Returns { schemaVersion, roots, truncated, alertVisible, keyboardVisible, unsupportedFields }.
Fails if the iOS ax-service predates the tree command; update argent.`,
    hideFromMcp: true,
    zodSchema,
    capability,
    services: () => ({}),
    execute: dispatchByPlatform({
      toolId: "ui-tree",
      capability,
      ios: {
        requires: iosRequires,
        handler: async (_services, _params, device) => {
          if (await isTvOsSimulator(device.id)) {
            throw new UnsupportedOperationError("ui-tree", device, "tvOS");
          }
          return readIosUiTree(registry, device);
        },
      },
      android: {
        requires: androidRequires,
        handler: async (_services, _params, device) => readAndroidUiTree(registry, device),
      },
    }),
  };
}
