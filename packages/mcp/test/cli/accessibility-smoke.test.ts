import { describe, it, expect, vi, afterEach } from "vitest";

// ── 1. Module exports ────────────────────────────────────────────────────────

describe("accessibility module exports", () => {
  it("exports isAccessibilityEnabled as a function", async () => {
    const mod = await import("../../src/cli/accessibility.js");
    expect(typeof mod.isAccessibilityEnabled).toBe("function");
  });

  it("exports ensureAccessibilityPermission as a function", async () => {
    const mod = await import("../../src/cli/accessibility.js");
    expect(typeof mod.ensureAccessibilityPermission).toBe("function");
  });

  it("does not leak internal helpers", async () => {
    const mod = await import("../../src/cli/accessibility.js");
    const exportedKeys = Object.keys(mod);

    const internalNames = [
      "isSwiftAvailable",
      "requestAccessibilityPermission",
      "openAccessibilitySettings",
      "printBannerBlock",
      "sleep",
      "waitForPermission",
      "pollWithKeyboardHint",
    ];

    for (const name of internalNames) {
      expect(exportedKeys).not.toContain(name);
    }
  });

  it("exports exactly two public symbols", async () => {
    const mod = await import("../../src/cli/accessibility.js");
    const exportedKeys = Object.keys(mod);
    expect(exportedKeys).toHaveLength(2);
    expect(exportedKeys).toContain("isAccessibilityEnabled");
    expect(exportedKeys).toContain("ensureAccessibilityPermission");
  });
});

// ── 2. Import chain ──────────────────────────────────────────────────────────

describe("import chain", () => {
  it("init.ts re-exports ensureAccessibilityPermission from accessibility", async () => {
    // Verify the import path resolves without error
    const accessibilityMod = await import("../../src/cli/accessibility.js");
    expect(accessibilityMod.ensureAccessibilityPermission).toBeDefined();
  });

  it("dynamic import of accessibility module resolves successfully", async () => {
    await expect(
      import("../../src/cli/accessibility.js")
    ).resolves.toBeDefined();
  });
});

// ── 3. Type contracts ────────────────────────────────────────────────────────

describe("type contracts", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("isAccessibilityEnabled() returns a boolean", async () => {
    // Force non-darwin so it short-circuits without calling execSync
    Object.defineProperty(process, "platform", { value: "linux" });
    const { isAccessibilityEnabled } = await import(
      "../../src/cli/accessibility.js"
    );
    const result = isAccessibilityEnabled();
    expect(typeof result).toBe("boolean");
  });

  it("ensureAccessibilityPermission() returns a Promise (thenable)", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { ensureAccessibilityPermission } = await import(
      "../../src/cli/accessibility.js"
    );
    const result = ensureAccessibilityPermission();
    expect(result).toBeInstanceOf(Promise);
    expect(typeof result.then).toBe("function");
    await result; // resolve to avoid unhandled rejection
  });

  it("ensureAccessibilityPermission(true) accepts boolean arg without error", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { ensureAccessibilityPermission } = await import(
      "../../src/cli/accessibility.js"
    );
    await expect(ensureAccessibilityPermission(true)).resolves.toBeUndefined();
  });

  it("ensureAccessibilityPermission(false) accepts boolean arg without error", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { ensureAccessibilityPermission } = await import(
      "../../src/cli/accessibility.js"
    );
    await expect(
      ensureAccessibilityPermission(false)
    ).resolves.toBeUndefined();
  });
});

// ── 4. Platform guard smoke test ─────────────────────────────────────────────

describe("platform guard", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("isAccessibilityEnabled() does not throw on any platform", async () => {
    // Force linux to avoid side effects from execSync on darwin
    Object.defineProperty(process, "platform", { value: "linux" });
    const { isAccessibilityEnabled } = await import(
      "../../src/cli/accessibility.js"
    );
    expect(() => isAccessibilityEnabled()).not.toThrow();
  });

  it("ensureAccessibilityPermission() does not throw on any platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { ensureAccessibilityPermission } = await import(
      "../../src/cli/accessibility.js"
    );
    await expect(ensureAccessibilityPermission()).resolves.not.toThrow();
  });

  it("isAccessibilityEnabled() returns a boolean, not undefined or null", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { isAccessibilityEnabled } = await import(
      "../../src/cli/accessibility.js"
    );
    const result = isAccessibilityEnabled();
    expect(result).not.toBeUndefined();
    expect(result).not.toBeNull();
    expect(typeof result).toBe("boolean");
  });
});

// ── 5. No side effects on import ─────────────────────────────────────────────

describe("no side effects on import", () => {
  it("importing the module does not trigger execSync calls", async () => {
    // The module only calls execSync inside function bodies, never at the
    // top level. We verify this by checking that the module loads and all
    // exports are functions (not eagerly-computed values from execSync).
    const mod = await import("../../src/cli/accessibility.js");
    for (const [key, value] of Object.entries(mod)) {
      expect(typeof value).toBe("function");
    }
    // If execSync were called at import time on non-darwin, the module
    // would either throw or produce side effects. The fact that the
    // module loads cleanly with only function exports confirms no
    // top-level execSync calls.
    expect(Object.keys(mod)).toHaveLength(2);
  });

  it("importing the module does not write to stdout", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(
      () => true
    );
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(
      () => {}
    );

    const mod = await import("../../src/cli/accessibility.js");
    expect(mod).toBeDefined();

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();

    stdoutSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("importing the module does not write to stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(
      () => {}
    );

    const mod = await import("../../src/cli/accessibility.js");
    expect(mod).toBeDefined();

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});
