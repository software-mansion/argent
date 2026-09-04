import { describe, it, expect, beforeEach, vi } from "vitest";
import { promptInstallMode } from "../src/init-mode-prompt.js";
import { hasProjectPackageJson } from "../src/utils.js";
import { log, select } from "@clack/prompts";
import type { GlobalInstallTarget } from "../src/global-prefix.js";

// The install-mode selector has to describe the machine it is running on: where
// a global install cannot be written, recommending "Globally" sends the user
// into the one option that cannot work.

vi.mock("../src/utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/utils.js")>();
  return {
    ...original,
    resolveProjectRoot: vi.fn(() => "/fake/project"),
    hasProjectPackageJson: vi.fn(() => true),
  };
});

vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return { ...actual, select: vi.fn(), log: { warn: vi.fn() } };
});

interface Option {
  value: string;
  label: string;
  hint?: string;
}

function shownOptions(): { options: Option[]; initialValue: string } {
  const [call] = vi.mocked(select).mock.calls[0] as [{ options: Option[]; initialValue: string }];
  return call;
}

const option = (value: string): Option => shownOptions().options.find((o) => o.value === value)!;

const nixStoreTarget: GlobalInstallTarget = {
  dir: "/nix/store/abc-nodejs-22.16.0/lib/node_modules",
  blocked: true,
  nixStore: true,
};

describe("promptInstallMode", () => {
  beforeEach(() => {
    vi.mocked(select).mockReset();
    vi.mocked(select).mockResolvedValue("global" as never);
    vi.mocked(log.warn).mockReset();
    vi.mocked(hasProjectPackageJson).mockReturnValue(true);
  });

  it("recommends and highlights global on a machine that can install globally", async () => {
    await promptInstallMode("global", null);

    expect(log.warn).not.toHaveBeenCalled();
    expect(option("global").label).toContain("(recommended)");
    expect(option("local").label).not.toContain("(recommended)");
    expect(shownOptions().initialValue).toBe("global");
  });

  it("keeps the committed mode highlighted when nothing is blocked", async () => {
    await promptInstallMode("local", null);

    expect(shownOptions().initialValue).toBe("local");
  });

  it("says why global cannot work here, and steers to local instead", async () => {
    await promptInstallMode("global", { target: nixStoreTarget, pm: "npm" });

    const [warning] = vi.mocked(log.warn).mock.calls[0] as [string];
    expect(warning).toContain("read-only Nix store");
    expect(warning).toContain(nixStoreTarget.dir);

    // The recommendation and the highlight both move off the blocked option,
    // and global says what choosing it would do.
    expect(option("global").label).not.toContain("(recommended)");
    expect(option("local").label).toContain("(recommended)");
    expect(shownOptions().initialValue).toBe("local");
    expect(option("global").hint).toContain(".npm-global");
  });

  it("overrides a committed global mode that this machine cannot honor", async () => {
    await promptInstallMode("global", { target: nixStoreTarget, pm: "npm" });

    expect(shownOptions().initialValue).toBe("local");
  });

  // Without a package.json there is no devDependency to fall back to, so local
  // is not the way out to point at — and not an option to offer either: it can
  // only route to installLocally's precondition error.
  it("offers only global when local has nowhere to install either", async () => {
    vi.mocked(hasProjectPackageJson).mockReturnValue(false);

    await promptInstallMode("global", { target: nixStoreTarget, pm: "npm" });

    expect(option("global").label).not.toContain("(recommended)");
    expect(shownOptions().options.map((o) => o.value)).toEqual(["global"]);
    expect(shownOptions().initialValue).toBe("global");
  });

  // A committed local record must not highlight an option this machine
  // dropped — the select would render nothing highlighted.
  it("highlights global when the committed local mode was dropped", async () => {
    vi.mocked(hasProjectPackageJson).mockReturnValue(false);

    await promptInstallMode("local", { target: nixStoreTarget, pm: "npm" });

    expect(shownOptions().options.map((o) => o.value)).toEqual(["global"]);
    expect(shownOptions().initialValue).toBe("global");
  });

  it("does not promise to move a prefix for a manager argent cannot relocate", async () => {
    await promptInstallMode("global", { target: nixStoreTarget, pm: "pnpm" });

    expect(option("global").hint).not.toContain(".npm-global");
    expect(option("global").hint).toContain("relocate pnpm's global directory");
  });
});
