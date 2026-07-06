import { describe, it, expect } from "vitest";
import {
  parseTargetFlags,
  decideInstallTargets,
  type DecideTargetsContext,
} from "../src/install-targets.js";

function ctx(overrides: Partial<DecideTargetsContext>): DecideTargetsContext {
  return {
    globalPresent: false,
    localPresent: false,
    defaultTarget: "global",
    flags: { global: false, local: false },
    nonInteractive: false,
    nonInteractiveBothDefault: ["local"],
    ...overrides,
  };
}

describe("parseTargetFlags", () => {
  it("detects --global and --local independently and additively", () => {
    expect(parseTargetFlags([])).toEqual({ global: false, local: false });
    expect(parseTargetFlags(["--global"])).toEqual({ global: true, local: false });
    expect(parseTargetFlags(["--local"])).toEqual({ global: false, local: true });
    expect(parseTargetFlags(["--global", "--local"])).toEqual({ global: true, local: true });
    expect(parseTargetFlags(["-y", "--local", "--no-telemetry"])).toEqual({
      global: false,
      local: true,
    });
  });
});

describe("decideInstallTargets — explicit flags win", () => {
  it("--global selects only global", () => {
    const d = decideInstallTargets(
      ctx({ globalPresent: true, flags: { global: true, local: false } })
    );
    expect(d).toEqual({ kind: "targets", targets: ["global"], reason: "flags" });
  });

  it("--local selects only local", () => {
    const d = decideInstallTargets(
      ctx({ localPresent: true, flags: { global: false, local: true } })
    );
    expect(d).toEqual({ kind: "targets", targets: ["local"], reason: "flags" });
  });

  it("--global --local selects both (order: global, local)", () => {
    const d = decideInstallTargets(
      ctx({ globalPresent: true, localPresent: true, flags: { global: true, local: true } })
    );
    expect(d).toEqual({ kind: "targets", targets: ["global", "local"], reason: "flags" });
  });

  it("flags win even when non-interactive and both present", () => {
    const d = decideInstallTargets(
      ctx({
        globalPresent: true,
        localPresent: true,
        nonInteractive: true,
        flags: { global: true, local: false },
      })
    );
    expect(d).toEqual({ kind: "targets", targets: ["global"], reason: "flags" });
  });
});

describe("decideInstallTargets — flags select regardless of what's installed", () => {
  it("--global selects global even with no global install (the command installs it)", () => {
    const d = decideInstallTargets(
      ctx({ globalPresent: false, flags: { global: true, local: false } })
    );
    expect(d).toEqual({ kind: "targets", targets: ["global"], reason: "flags" });
  });

  it("--local selects local even when not installed (the command guides the user)", () => {
    const d = decideInstallTargets(
      ctx({ localPresent: false, flags: { global: false, local: true } })
    );
    expect(d).toEqual({ kind: "targets", targets: ["local"], reason: "flags" });
  });

  it("--global --local selects both even if one is absent", () => {
    const d = decideInstallTargets(
      ctx({ globalPresent: true, localPresent: false, flags: { global: true, local: true } })
    );
    expect(d).toEqual({ kind: "targets", targets: ["global", "local"], reason: "flags" });
  });
});

describe("decideInstallTargets — no flags, single install present", () => {
  it("only global present → global", () => {
    const d = decideInstallTargets(ctx({ globalPresent: true, defaultTarget: "global" }));
    expect(d).toEqual({ kind: "targets", targets: ["global"], reason: "single" });
  });

  it("only local present → local (defaultTarget)", () => {
    const d = decideInstallTargets(ctx({ localPresent: true, defaultTarget: "local" }));
    expect(d).toEqual({ kind: "targets", targets: ["local"], reason: "single" });
  });

  it("neither present → falls back to the default target", () => {
    expect(decideInstallTargets(ctx({ defaultTarget: "global" }))).toEqual({
      kind: "targets",
      targets: ["global"],
      reason: "single",
    });
    expect(decideInstallTargets(ctx({ defaultTarget: "local" }))).toEqual({
      kind: "targets",
      targets: ["local"],
      reason: "single",
    });
  });
});

describe("decideInstallTargets — no flags, both installs coexist", () => {
  it("interactive → prompt", () => {
    const d = decideInstallTargets(
      ctx({ globalPresent: true, localPresent: true, defaultTarget: "local" })
    );
    expect(d).toEqual({ kind: "prompt" });
  });

  it("non-interactive → the caller-provided both-default, never a prompt", () => {
    const d = decideInstallTargets(
      ctx({
        globalPresent: true,
        localPresent: true,
        defaultTarget: "local",
        nonInteractive: true,
        nonInteractiveBothDefault: ["local"],
      })
    );
    expect(d).toEqual({ kind: "targets", targets: ["local"], reason: "noninteractive-both" });
  });

  it("non-interactive both-default is caller-configurable", () => {
    const d = decideInstallTargets(
      ctx({
        globalPresent: true,
        localPresent: true,
        nonInteractive: true,
        nonInteractiveBothDefault: ["global", "local"],
      })
    );
    expect(d).toEqual({
      kind: "targets",
      targets: ["global", "local"],
      reason: "noninteractive-both",
    });
  });
});
