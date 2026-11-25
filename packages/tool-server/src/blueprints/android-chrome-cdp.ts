import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import { adbForward, adbShell, runAdb } from "../utils/adb";
import { CDPClient } from "../utils/debugger/cdp-client";
import { withKeyedLock } from "../utils/keyed-lock";
import {
  ensureCdpReachable,
  listPageTargets,
  type CdpTarget,
} from "../chromium-server/cdp-session";
import { evaluateDescribeDom } from "../tools/describe/platforms/chromium";
import type { DescribeTreeData } from "../tools/describe/contract";

export const ANDROID_CHROME_CDP_NAMESPACE = "AndroidChromeCdp";

export function androidChromeCdpRef(serial: string): string {
  return `${ANDROID_CHROME_CDP_NAMESPACE}:${serial}`;
}

/** The page's viewports, in CSS px, read beside the DOM walk. */
export interface WebViewport {
  innerWidth: number;
  innerHeight: number;
  dpr: number;
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
  scale: number;
}

export interface AndroidChromeCdpApi {
  /** Walks the DOM of the visible tab of the Chrome-family browser `pkg`. */
  readVisibleTab(pkg: string): Promise<DescribeTreeData & { viewport: WebViewport }>;
}

/**
 * Chrome's listening DevTools sockets in `/proc/net/unix`, name to inode:
 * `@chrome_devtools_remote`, or with a `_<pid>` suffix when another browser
 * holds that name. Browsers swap names across restarts, so the inode tells a
 * reused name apart. WebView and Stetho sockets (`@webview_devtools_remote_*`,
 * `@stetho_*_devtools_remote`) do not match.
 */
export function parseChromeDevtoolsSockets(procNetUnix: string): Map<string, string> {
  const sockets = new Map<string, string>();
  for (const line of procNetUnix.split("\n")) {
    // Num RefCount Protocol Flags Type St Inode Path; flags 00010000 = listening.
    const m = /\s00010000\s+\S+\s+\S+\s+(\d+)\s+@(chrome_devtools_remote(?:_\d+)?)\s*$/.exec(line);
    if (m) sockets.set(m[2]!, m[1]!);
  }
  return sockets;
}

/**
 * Older Chrome publishes its tabs to UiAutomation, a little late: reading them
 * over DevTools would race that tree and flip roles between calls.
 */
const MIN_CHROME_MAJOR = 158;

/** The major version in `/json/version`'s `Browser` ("Chrome/160.0.8182.0"), if any. */
function browserMajor(browser: string | undefined): number | undefined {
  const m = /\/(\d+)\./.exec(browser ?? "");
  return m ? Number(m[1]) : undefined;
}

/** A frozen background tab accepts the socket and never answers, so every probe is bounded. */
const PROBE_TIMEOUT_MS = 1_000;
const WALK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const VIEWPORT_EXPRESSION = `JSON.stringify({
  innerWidth, innerHeight, dpr: devicePixelRatio,
  offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop,
  width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale,
})`;

async function evaluateValue(cdp: CDPClient, expression: string, timeoutMs: number) {
  const r = (await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true },
    timeoutMs
  )) as {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
  };
  if (r.exceptionDetails) throw new Error("evaluation threw");
  return r.result?.value;
}

/**
 * Chrome 158+ publishes no accessibility tree for a regular tab while only
 * UiAutomation is connected, so `describe` reads the tab over Chrome's
 * DevTools socket instead. Holds the adb forwards and the connection to the
 * last visible tab between calls.
 */
export const androidChromeCdpBlueprint: ServiceBlueprint<AndroidChromeCdpApi, string> = {
  namespace: ANDROID_CHROME_CDP_NAMESPACE,

  getURN(serial: string) {
    return androidChromeCdpRef(serial);
  },

  async factory(_deps, serial) {
    // Socket name → its inode, forwarded host port and the browser package and
    // major version behind it.
    const forwards = new Map<
      string,
      { inode: string; port: number; pkg?: string; major?: number }
    >();
    let tab: { id: string; pkg: string; cdp: CDPClient } | undefined;

    const removeForward = async (port: number) => {
      await runAdb(["-s", serial, "forward", "--remove", `tcp:${port}`], {
        timeoutMs: 5_000,
      }).catch(() => undefined);
    };

    const browserPort = async (pkg: string): Promise<{ port: number; major?: number }> => {
      const sockets = parseChromeDevtoolsSockets(
        await adbShell(serial, "cat /proc/net/unix", { timeoutMs: 5_000 })
      );
      for (const [name, entry] of forwards) {
        const inode = sockets.get(name);
        if (inode === entry.inode) continue;
        if (inode === undefined) {
          forwards.delete(name);
          await removeForward(entry.port);
        } else {
          // A new socket under the name, maybe another browser's: the forward
          // follows the name, the package must be read again.
          entry.inode = inode;
          entry.pkg = undefined;
          entry.major = undefined;
        }
      }
      const known = [...forwards.values()].find((e) => e.pkg === pkg);
      if (known) return known;
      // Only sockets of unknown owner are asked, all at once: a frozen browser
      // never answers, and is asked again only while `pkg` is not found.
      const asked = await Promise.all(
        [...sockets].map(async ([name, inode]) => {
          let entry = forwards.get(name);
          if (entry?.pkg) return undefined;
          if (!entry) {
            const printed = await adbForward(
              serial,
              0,
              { localabstract: name },
              { timeoutMs: 5_000 }
            ).catch(() => "");
            if (!/^\d+$/.test(printed)) return undefined;
            entry = { inode, port: Number(printed) };
            forwards.set(name, entry);
          }
          const version = await ensureCdpReachable(
            entry.port,
            AbortSignal.timeout(PROBE_TIMEOUT_MS)
          ).catch(() => undefined);
          entry.pkg = version?.["Android-Package"];
          entry.major = browserMajor(version?.Browser);
          return entry;
        })
      );
      const found = asked.find((e) => e?.pkg === pkg);
      if (found) return found;
      throw new Error(`no DevTools socket for ${pkg}`);
    };

    const dropTab = () => {
      void tab?.cdp.disconnect();
      tab = undefined;
    };

    /** The client attached to `target` when its document is visible, else undefined. */
    const probe = async (target: CdpTarget): Promise<CDPClient | undefined> => {
      let cdp = tab?.id === target.id && tab.cdp.isConnected() ? tab.cdp : undefined;
      if (!cdp) {
        cdp = new CDPClient(target.webSocketDebuggerUrl!, { sendOrigin: false });
        const opening = cdp.connect();
        try {
          await withTimeout(opening, PROBE_TIMEOUT_MS, "CDP connect");
        } catch {
          void opening.then(() => cdp!.disconnect()).catch(() => undefined);
          return undefined;
        }
      }
      const visible = await evaluateValue(cdp, "document.visibilityState", PROBE_TIMEOUT_MS).catch(
        () => undefined
      );
      if (visible === "visible") return cdp;
      if (cdp !== tab?.cdp) void cdp.disconnect();
      return undefined;
    };

    /**
     * Probes every tab at once and settles on the first visible one: a restored
     * or discarded tab accepts the socket and never answers, and the visible tab
     * can be anywhere in `/json/list`. Slower probes run out on their own and
     * close their clients.
     */
    const firstVisible = (targets: CdpTarget[]) =>
      new Promise<{ target: CdpTarget; cdp: CDPClient } | undefined>((resolve) => {
        let pending = targets.length;
        let picked = false;
        for (const target of targets) {
          void probe(target)
            .catch(() => undefined)
            .then((cdp) => {
              if (cdp && !picked) {
                picked = true;
                resolve({ target, cdp });
              } else if (cdp && cdp !== tab?.cdp) void cdp.disconnect();
              if (--pending === 0) resolve(undefined);
            });
        }
      });

    const pickVisibleTab = async (
      pkg: string,
      { port, major }: { port: number; major?: number }
    ): Promise<CDPClient> => {
      // A tab is cached only past this check, so the fast path needs none.
      if (major !== undefined && major < MIN_CHROME_MAJOR) {
        throw new Error(`Chrome ${major} publishes its tabs to accessibility`);
      }
      const targets = await listPageTargets(port, AbortSignal.timeout(PROBE_TIMEOUT_MS));
      if (targets.length === 0) throw new Error("no page targets");
      const picked = await firstVisible(targets);
      if (!picked) throw new Error("no visible tab");
      if (tab && tab.cdp !== picked.cdp) dropTab();
      tab = { id: picked.target.id, pkg, cdp: picked.cdp };
      return picked.cdp;
    };

    /**
     * The last visible tab's client while it is still connected and visible:
     * then neither the sockets nor the other tabs are read. A tab that stops
     * answering is dropped; a hidden one is kept for the fan-out to reuse.
     */
    const cachedVisible = async (pkg: string): Promise<CDPClient | undefined> => {
      if (tab?.pkg !== pkg || !tab.cdp.isConnected()) return undefined;
      const visible = await evaluateValue(
        tab.cdp,
        "document.visibilityState",
        PROBE_TIMEOUT_MS
      ).catch(() => dropTab());
      return visible === "visible" ? tab?.cdp : undefined;
    };

    const readVisibleTab = async (pkg: string) => {
      const cdp = (await cachedVisible(pkg)) ?? (await pickVisibleTab(pkg, await browserPort(pkg)));
      try {
        const viewport = JSON.parse(
          String(await evaluateValue(cdp, VIEWPORT_EXPRESSION, PROBE_TIMEOUT_MS))
        ) as WebViewport;
        const data = await withTimeout(evaluateDescribeDom(cdp), WALK_TIMEOUT_MS, "DOM walk");
        return { ...data, viewport };
      } catch (err) {
        dropTab();
        throw err;
      }
    };

    // One read at a time: two would race on `forwards` and `tab`.
    const locks = new Map<string, Promise<unknown>>();
    const api: AndroidChromeCdpApi = {
      readVisibleTab: (pkg) => withKeyedLock(locks, serial, () => readVisibleTab(pkg)),
    };

    const dispose = (): Promise<void> =>
      withKeyedLock(locks, serial, async () => {
        dropTab();
        for (const { port } of forwards.values()) await removeForward(port);
        forwards.clear();
      });

    return { api, dispose, events: new TypedEventEmitter<ServiceEvents>() };
  },
};
