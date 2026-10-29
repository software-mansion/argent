import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tracked-app record (whether the app is sandboxed, and read-only for the
// files a user chooses) and the helper binary that issues the sandbox token
// are host state, faked here.
const tracked = { sandboxed: false, userSelectedReadOnly: false };
const issueSandboxExtension = vi.fn(
  async (p: string, _opts?: { readOnly?: boolean }) => `token-for:${p}`
);
vi.mock("../src/utils/macos-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/macos-apps")>()),
  getTrackedMacosApp: (bundleId: string) =>
    bundleId === "com.example.Probe" ? { bundleId, ...tracked } : undefined,
  issueSandboxExtension: (p: string, opts?: { readOnly?: boolean }) =>
    issueSandboxExtension(p, opts),
}));

import { FAILURE_CODES, ToolNotFoundError, getFailureSignal } from "@argent/registry";
import { assertSupported, UnsupportedOperationError } from "../src/utils/capability";
import { resolveDevice } from "../src/utils/device-info";
import { filePanelTool } from "../src/tools/file-panel";
import { useMacosAppsFlag } from "./helpers/macos-apps-flag";
import {
  MAC_ID,
  errorOf,
  fakeMacosApp,
  macosToolRegistry,
  type LibraryCall,
} from "./helpers/macos-input-fake";

const flag = useMacosAppsFlag();

type Panel = { number: number; kind: "open" | "save" } & Record<string, unknown>;

/** A library whose panel list a test can change between polls (a panel that appears after the click). */
function harness(initialPanels: Panel[] = []) {
  let panels = initialPanels;
  const { app, calls } = fakeMacosApp({
    "Panel.list": () => ({ panels }),
    "Panel.stub": (p) => ({ armed: p.mode !== "off" }),
  });
  const { registry, urns } = macosToolRegistry(app, () => [filePanelTool]);
  return {
    registry,
    calls,
    urns,
    setPanels: (next: Panel[]) => {
      panels = next;
    },
    invoke: (args: Record<string, unknown>) =>
      registry.invokeTool("file-panel", { udid: MAC_ID, ...args }),
  };
}

const nonListCalls = (calls: LibraryCall[]) => calls.filter((c) => c.method !== "Panel.list");
const granted = () => issueSandboxExtension.mock.calls.map((c) => c[0]);

const openPanel: Panel = {
  number: 41,
  kind: "open",
  title: "Open",
  allowsMultiple: false,
  canChooseDirectories: false,
};
const savePanel: Panel = { number: 42, kind: "save", title: "Save", nameField: "Untitled" };

let sandbox: string;
let fileA: string;
let fileB: string;

beforeEach(() => {
  tracked.sandboxed = false;
  tracked.userSelectedReadOnly = false;
  issueSandboxExtension.mockClear();
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-file-panel-")));
  fileA = path.join(sandbox, "a.txt");
  fileB = path.join(sandbox, "b.txt");
  fs.writeFileSync(fileA, "seventeen bytes!\n");
  fs.writeFileSync(fileB, "b");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("file-panel", () => {
  it("is hidden behind the macos-apps flag and declared for Mac apps only", async () => {
    expect(filePanelTool.featureFlag).toBe("macos-apps");
    expect(filePanelTool.capability).toEqual({ macos: { app: true } });
    expect(() =>
      assertSupported("file-panel", filePanelTool.capability, resolveDevice("emulator-5554"))
    ).toThrow(UnsupportedOperationError);
    flag.off();
    const { invoke, urns } = harness();
    expect(await errorOf(invoke({ action: "list" }))).toBeInstanceOf(ToolNotFoundError);
    expect(urns).toEqual([]);
  });

  it("refuses a device that is not a Mac app even when a flow skips the capability gate", async () => {
    const { registry, urns } = harness();
    const err = await errorOf(
      registry.invokeTool("file-panel", { udid: "chromium-cdp-9222", action: "list" })
    );
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.TOOL_CAPABILITY_UNSUPPORTED_OPERATION
    );
    expect(urns).toEqual([]);
  });

  it("lists the open panels", async () => {
    const { invoke } = harness([openPanel, savePanel]);
    await expect(invoke({ action: "list" })).resolves.toEqual({ panels: [openPanel, savePanel] });
  });

  it("choose answers the open panel with the file", async () => {
    const { invoke, calls } = harness([openPanel]);
    await expect(invoke({ action: "choose", path: fileA })).resolves.toEqual({
      chosen: true,
      panel: 41,
      kind: "open",
      paths: [fileA],
    });
    expect(nonListCalls(calls)).toEqual([
      { method: "Panel.complete", params: { path: fileA, panel: 41 } },
    ]);
    // An app that is not sandboxed gets no grant.
    expect(issueSandboxExtension).not.toHaveBeenCalled();
  });

  it("choose waits for a panel that appears after the click", async () => {
    const { invoke, calls, setPanels } = harness([]);
    setTimeout(() => setPanels([openPanel]), 250);
    await expect(invoke({ action: "choose", path: fileA, timeoutMs: 3000 })).resolves.toMatchObject(
      { chosen: true, panel: 41 }
    );
    expect(calls.filter((c) => c.method === "Panel.list").length).toBeGreaterThan(1);
  });

  it("choose fails with the fix when no panel appears in time", async () => {
    const { invoke, calls } = harness([]);
    const err = await errorOf(invoke({ action: "choose", path: fileA, timeoutMs: 150 }));
    expect(err?.message).toMatch(/No file panel is open in com\.example\.Probe/);
    expect(err?.message).toMatch(/action stub/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(nonListCalls(calls)).toEqual([]);
  });

  it("choose needs the panel number when several panels are open", async () => {
    const { invoke, calls } = harness([openPanel, { ...openPanel, number: 43 }]);
    const err = await errorOf(invoke({ action: "choose", path: fileA }));
    expect(err?.message).toMatch(/2 file panels are open \(numbers 41, 43\)/);
    await expect(invoke({ action: "choose", path: fileA, panel: 43 })).resolves.toMatchObject({
      panel: 43,
    });
    expect(nonListCalls(calls)).toEqual([
      { method: "Panel.complete", params: { path: fileA, panel: 43 } },
    ]);
  });

  it.each([
    [{ path: "relative/a.txt" }, /absolute path/],
    [{ path: "/no/such/file.txt" }, /does not exist/],
    [{ paths: ["A", "B"].map((n) => `/tmp/${n}`) }, /takes one item/],
    [{}, /needs path/],
    [{ path: "/tmp/a", paths: ["/tmp/b"] }, /path or paths, not both/],
  ])("choose refuses %j before anything reaches the panel", async (args, message) => {
    const { invoke, calls } = harness([openPanel]);
    const err = await errorOf(invoke({ action: "choose", ...args }));
    expect(err?.message).toMatch(message);
    expect(nonListCalls(calls)).toEqual([]);
  });

  it("choose passes a document package (a folder on disk) to a files-only open panel", async () => {
    const pkg = path.join(sandbox, "Notes.rtfd");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "TXT.rtf"), "{\\rtf1}");
    const { invoke, calls } = harness([openPanel]);
    await expect(invoke({ action: "choose", path: pkg })).resolves.toMatchObject({ paths: [pkg] });
    expect(nonListCalls(calls)).toEqual([
      { method: "Panel.complete", params: { path: pkg, panel: 41 } },
    ]);
  });

  it("stops waiting for a panel when the call is cancelled", async () => {
    const { registry, calls } = harness([]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const err = await errorOf(
      registry.invokeTool(
        "file-panel",
        { udid: MAC_ID, action: "choose", path: fileA, timeoutMs: 10_000 },
        { signal: controller.signal }
      )
    );
    expect(err?.message).toMatch(/aborted while it waited for a panel/);
    expect(nonListCalls(calls)).toEqual([]);
  });

  it("choose answers a save panel with the file to write, in an existing folder", async () => {
    const { invoke, calls } = harness([savePanel]);
    const target = path.join(sandbox, "out.txt");
    await expect(invoke({ action: "choose", path: target })).resolves.toMatchObject({
      kind: "save",
      paths: [target],
    });
    expect(nonListCalls(calls)).toEqual([
      { method: "Panel.complete", params: { path: target, panel: 42 } },
    ]);
    const missing = await errorOf(
      invoke({ action: "choose", path: path.join(sandbox, "nope", "x.txt") })
    );
    expect(missing?.message).toMatch(
      /does not exist\. A save panel writes into an existing folder/
    );
  });

  it.each(["", "release-1.2", "Notes.rtfd"])(
    "choose refuses an existing folder (%j) as the file of a save panel",
    async (name) => {
      tracked.sandboxed = true;
      const folder = path.join(sandbox, name);
      fs.mkdirSync(folder, { recursive: true });
      const { invoke, calls } = harness([savePanel]);
      const err = await errorOf(invoke({ action: "choose", path: folder }));
      expect(err?.message).toMatch(/is a folder, not a file to write\. Pass a path inside it/);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
      expect(nonListCalls(calls)).toEqual([]);
      expect(issueSandboxExtension).not.toHaveBeenCalled();
    }
  );

  it("expands a leading ~/ to the home folder", async () => {
    const home = path.join(sandbox, "home");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "doc.txt"), "x");
    // os.homedir() reads HOME first, and the flag lives under it.
    vi.stubEnv("HOME", home);
    flag.on();
    const { invoke, calls } = harness([openPanel]);
    await invoke({ action: "choose", path: "~/doc.txt" });
    expect(nonListCalls(calls)[0]!.params.path).toBe(path.join(home, "doc.txt"));
  });

  it.each([
    ["the files of an open panel", { ...openPanel, allowsMultiple: true }, () => [fileA, fileB]],
    ["only the new file of a save panel", savePanel, () => [path.join(sandbox, "new.txt")]],
  ])("gives a sandboxed app %s with the answer", async (_label, panel, paths) => {
    tracked.sandboxed = true;
    const { invoke, calls } = harness([panel]);
    const chosen = paths();
    await invoke({ action: "choose", paths: chosen });
    expect(granted()).toEqual(chosen);
    expect(nonListCalls(calls)).toEqual([
      {
        method: "Panel.complete",
        params: {
          ...(chosen.length === 1 ? { path: chosen[0] } : { paths: chosen }),
          tokens: chosen.map((t) => `token-for:${t}`),
          panel: panel.number,
        },
      },
    ]);
  });

  it("does not check the path against the panel's allowed file types", async () => {
    const { invoke, calls } = harness([{ ...openPanel, allowedContentTypes: ["public.png"] }]);
    await expect(invoke({ action: "choose", path: fileA })).resolves.toMatchObject({
      chosen: true,
    });
    expect(nonListCalls(calls)).toEqual([
      { method: "Panel.complete", params: { path: fileA, panel: 41 } },
    ]);
  });

  it("grants the resolved path when the chosen path goes through a symlink", async () => {
    tracked.sandboxed = true;
    const link = path.join(sandbox, "link");
    fs.mkdirSync(path.join(sandbox, "real"));
    fs.writeFileSync(path.join(sandbox, "real", "c.txt"), "c");
    fs.symlinkSync(path.join(sandbox, "real"), link);
    const { invoke, calls } = harness([openPanel, savePanel]);
    await invoke({ action: "choose", path: path.join(link, "c.txt"), panel: 41 });
    expect(granted()).toEqual([path.join(sandbox, "real", "c.txt")]);
    expect(nonListCalls(calls).at(-1)).toMatchObject({
      method: "Panel.complete",
      params: { path: path.join(link, "c.txt"), panel: 41 },
    });
    // A file to save does not exist yet: the grant names it in the resolved folder.
    issueSandboxExtension.mockClear();
    await invoke({ action: "choose", path: path.join(link, "new.txt"), panel: 42 });
    expect(granted()).toEqual([path.join(sandbox, "real", "new.txt")]);
  });

  it("does not complete the panel when the sandbox token cannot be issued", async () => {
    tracked.sandboxed = true;
    issueSandboxExtension.mockRejectedValueOnce(
      new Error("Could not give the sandboxed app access")
    );
    const { invoke, calls } = harness([openPanel]);
    const err = await errorOf(invoke({ action: "choose", path: fileA }));
    expect(err?.message).toMatch(/Could not give the sandboxed app access/);
    expect(nonListCalls(calls)).toEqual([]);
  });

  it.each([true, false])(
    "grants read-only access exactly when the app may only read the files a user chooses (%s)",
    async (readOnly) => {
      tracked.sandboxed = true;
      tracked.userSelectedReadOnly = readOnly;
      const { invoke } = harness([openPanel]);
      await invoke({ action: "choose", path: fileA });
      expect(issueSandboxExtension.mock.calls).toEqual([[fileA, { readOnly }]]);
    }
  );

  it("cancel cancels the panel", async () => {
    const { invoke, calls } = harness([savePanel]);
    await expect(invoke({ action: "cancel" })).resolves.toEqual({ cancelled: true, panel: 42 });
    expect(nonListCalls(calls)).toEqual([{ method: "Panel.cancel", params: { panel: 42 } }]);
  });

  it("discard answers the panel with its Delete or Don't Save button", async () => {
    const { invoke, calls } = harness([savePanel]);
    await expect(invoke({ action: "discard" })).resolves.toEqual({ discarded: true, panel: 42 });
    expect(nonListCalls(calls)).toEqual([{ method: "Panel.discard", params: { panel: 42 } }]);
  });

  it("stub infers an open panel for existing paths and grants each path itself", async () => {
    tracked.sandboxed = true;
    const { invoke, calls } = harness();
    await expect(invoke({ action: "stub", paths: [fileA, fileB] })).resolves.toEqual({
      armed: true,
      mode: "answer",
      panelKind: "open",
    });
    expect(issueSandboxExtension.mock.calls).toEqual([
      [fileA, { readOnly: false }],
      [fileB, { readOnly: false }],
    ]);
    expect(calls).toEqual([
      {
        method: "Panel.stub",
        params: {
          mode: "answer",
          paths: [fileA, fileB],
          tokens: [`token-for:${fileA}`, `token-for:${fileB}`],
        },
      },
    ]);
  });

  it("stub infers a save panel for a new path and grants only that file", async () => {
    tracked.sandboxed = true;
    const { invoke, calls } = harness();
    const newFile = path.join(sandbox, "new.txt");
    await expect(invoke({ action: "stub", path: newFile })).resolves.toEqual({
      armed: true,
      mode: "answer",
      panelKind: "save",
    });
    expect(granted()).toEqual([newFile]);
    expect(calls).toEqual([
      {
        method: "Panel.stub",
        params: { mode: "answer", path: newFile, tokens: [`token-for:${newFile}`] },
      },
    ]);
  });

  it("stub with a home folder grants that folder, not the folder above it", async () => {
    tracked.sandboxed = true;
    const home = path.join(sandbox, "home");
    fs.mkdirSync(home);
    vi.stubEnv("HOME", home);
    flag.on();
    const { invoke } = harness();
    await expect(invoke({ action: "stub", path: "~" })).resolves.toMatchObject({
      panelKind: "open",
    });
    expect(granted()).toEqual([home]);
  });

  it("stub grants the resolved target of a link, not the link", async () => {
    tracked.sandboxed = true;
    const elsewhere = path.join(sandbox, "elsewhere");
    fs.mkdirSync(elsewhere);
    const target = path.join(elsewhere, "doc.txt");
    fs.writeFileSync(target, "x");
    const link = path.join(sandbox, "link.txt");
    fs.symlinkSync(target, link);
    const { invoke } = harness();
    await invoke({ action: "stub", path: link });
    expect(granted()).toEqual([target]);
  });

  it.each([
    [{ path: "/no/such/folder/x.txt" }, /does not exist, and neither does its folder/],
    [{ path: "/no/such/file.txt", panelKind: "open" }, /does not exist\./],
    [{ path: "/no/such/folder/x.txt", panelKind: "save" }, /writes into an existing folder/],
    [{ paths: ["/tmp/a", "/tmp/b"], panelKind: "save" }, /takes one path/],
  ])("stub refuses %j before anything is granted or armed", async (args, message) => {
    tracked.sandboxed = true;
    const { invoke, calls } = harness();
    const err = await errorOf(invoke({ action: "stub", ...args }));
    expect(err?.message).toMatch(message);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
    expect(calls).toEqual([]);
    expect(issueSandboxExtension).not.toHaveBeenCalled();
  });

  it("stub with panelKind save refuses an existing folder, also one named like a package", async () => {
    tracked.sandboxed = true;
    const { invoke, calls } = harness();
    const pkg = path.join(sandbox, "Deck.key");
    fs.mkdirSync(pkg);
    for (const folder of [sandbox, pkg]) {
      const err = await errorOf(invoke({ action: "stub", path: folder, panelKind: "save" }));
      expect(err?.message).toMatch(/is a folder, not a file to write/);
    }
    expect(calls).toEqual([]);
    expect(issueSandboxExtension).not.toHaveBeenCalled();
  });

  it("stub without panelKind answers an existing folder as an open panel and grants only that folder", async () => {
    tracked.sandboxed = true;
    const folder = path.join(sandbox, "Documents");
    fs.mkdirSync(folder);
    const { invoke } = harness();
    await expect(invoke({ action: "stub", path: folder })).resolves.toMatchObject({
      panelKind: "open",
    });
    expect(granted()).toEqual([folder]);
  });

  it("stub cancel and off take no path", async () => {
    const { invoke, calls } = harness();
    await expect(invoke({ action: "stub", stubMode: "cancel" })).resolves.toEqual({
      armed: true,
      mode: "cancel",
    });
    await expect(invoke({ action: "stub", stubMode: "off" })).resolves.toEqual({
      armed: false,
      mode: "off",
    });
    expect(calls).toEqual([
      { method: "Panel.stub", params: { mode: "cancel" } },
      { method: "Panel.stub", params: { mode: "off" } },
    ]);
    const err = await errorOf(invoke({ action: "stub", stubMode: "off", path: fileA }));
    expect(err?.message).toMatch(/stubMode off takes no path/);
    const kind = await errorOf(invoke({ action: "stub", stubMode: "cancel", panelKind: "open" }));
    expect(kind?.message).toMatch(/takes no path and no panelKind/);
  });
});
