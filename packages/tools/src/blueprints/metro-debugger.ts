import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@radon-lite/registry";
import { discoverMetro } from "../metro/discovery";
import { selectTarget } from "../metro/target-selection";
import { CDPClient } from "../metro/cdp-client";
import { createSourceResolver, type SourceResolver } from "../metro/source-resolver";
import { SourceMapsRegistry } from "../metro/source-maps";

export const METRO_DEBUGGER_NAMESPACE = "MetroDebugger";

export interface MetroDebuggerApi {
  port: number;
  projectRoot: string;
  deviceName: string;
  isNewDebugger: boolean;
  cdp: CDPClient;
  sourceResolver: SourceResolver;
  sourceMaps: SourceMapsRegistry;
}

export const metroDebuggerBlueprint: ServiceBlueprint<
  MetroDebuggerApi,
  string
> = {
  namespace: METRO_DEBUGGER_NAMESPACE,

  getURN(port: string) {
    return `${METRO_DEBUGGER_NAMESPACE}:${port}`;
  },

  async factory(_deps, payload, options?) {
    const port = parseInt(payload, 10);

    const metro = await discoverMetro(port);
    const selected = selectTarget(metro.targets, port, options);

    const cdp = new CDPClient(selected.webSocketUrl);
    await cdp.connect();

    const sourceMaps = new SourceMapsRegistry(metro.projectRoot);

    cdp.events.on("scriptParsed", (script) => {
      sourceMaps.registerFromScriptParsed(
        script.url,
        script.scriptId,
        script.sourceMapURL
      );
    });

    const ignore = () => {};
    await cdp.send("FuseboxClient.setClientMetadata", {}).catch(ignore);
    await cdp.send("ReactNativeApplication.enable", {}).catch(ignore);
    await cdp.send("Runtime.enable");
    await cdp.send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
    await cdp.send("Debugger.setPauseOnExceptions", { state: "none" });
    await cdp
      .send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 })
      .catch(ignore);
    await cdp.send("Runtime.runIfWaitingForDebugger").catch(ignore);
    await cdp.addBinding("__radon_lite_callback");

    await sourceMaps.waitForPending();

    const sourceResolver = createSourceResolver(port, metro.projectRoot);

    const api: MetroDebuggerApi = {
      port,
      projectRoot: metro.projectRoot,
      deviceName: selected.deviceName,
      isNewDebugger: selected.isNewDebugger,
      cdp,
      sourceResolver,
      sourceMaps,
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit("terminated", error ?? new Error("CDP disconnected"));
    });

    return {
      api,
      dispose: async () => {
        await cdp.disconnect();
      },
      events,
    };
  },
};
