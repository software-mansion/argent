import { z } from "zod";
import type { DeviceInfo, Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { axServiceRef, type AXServiceApi } from "../../blueprints/ax-service";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { UnsupportedOperationError } from "../../utils/capability";
import { isTvOsSimulator } from "../../utils/ios-devices";
import { iosRequires } from "../describe/platforms/ios";
import { androidRequires } from "../describe/platforms/android";
import { adaptAndroidTree } from "../ui-tree/android";

// Mirrored, with field docs, in argent/src/client.ts. Same meaning as ui-tree's
// foregroundApp and alertVisible.
interface ForegroundApp {
  bundleId?: string;
  name?: string;
  alertVisible?: boolean;
}

const zodSchema = z.object({
  udid: z.string().min(1).describe("Target device id from `list-devices`."),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

async function readIosForegroundApp(
  registry: Registry,
  device: DeviceInfo
): Promise<ForegroundApp> {
  const ref = axServiceRef(device);
  const ax = await registry.resolveService<AXServiceApi>(ref.urn, ref.options);
  const { bundleId, name, alertVisible } = await ax.foregroundApp();
  return { bundleId, name, alertVisible };
}

// Window roots only: what ui-tree reads foregroundApp and alertVisible from, without the walk.
async function readAndroidForegroundApp(
  registry: Registry,
  device: DeviceInfo
): Promise<ForegroundApp> {
  const ref = androidDevtoolsRef(device);
  const devtools = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
  const [capture, size] = await Promise.all([
    // The default settle, as ui-tree: free on a settled screen, and it keeps a
    // mid-transition window list (right after home or a launch) from naming the old app.
    devtools.getHierarchy({ maxDepth: 0, clearCache: true }),
    devtools.getScreenSize(),
  ]);
  // maxDepth 0 cuts every window's children, never a window, so the window list is complete.
  const tree = adaptAndroidTree({ ...capture, truncated: false }, size);
  return { bundleId: tree.foregroundApp, alertVisible: tree.alertVisible };
}

export function createForegroundAppTool(registry: Registry): ToolDefinition<Params, ForegroundApp> {
  return {
    id: "foreground-app",
    interaction: {
      startedMsg: () => "Reading foreground app",
      completedMsg: () => "Read foreground app",
      failedMsg: ({ failureSignal }) =>
        `Failed to read foreground app: ${failureSignal.error_code}`,
    },
    description: `Read which app is in front, for SDK callers.
Returns { bundleId, name, alertVisible }; under a system alert, bundleId is the app it covers.
A field is unset when it is unknown.`,
    hideFromMcp: true,
    readOnly: true,
    zodSchema,
    capability,
    services: () => ({}),
    execute: dispatchByPlatform({
      toolId: "foreground-app",
      capability,
      ios: {
        requires: iosRequires,
        handler: async (_services, _params, device) => {
          if (await isTvOsSimulator(device.id)) {
            throw new UnsupportedOperationError("foreground-app", device, "tvOS");
          }
          return readIosForegroundApp(registry, device);
        },
      },
      iosRemote: {
        requires: ["sim-remote"],
        handler: async (_services, _params, device) => readIosForegroundApp(registry, device),
      },
      android: {
        requires: androidRequires,
        handler: async (_services, _params, device) => readAndroidForegroundApp(registry, device),
      },
    }),
  };
}
