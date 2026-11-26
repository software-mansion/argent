import { vi } from "vitest";

// The Argent Cloud CLI resolver probes PATH and `~/.local/bin` and spawns
// `--version`, which would add calls to every test's `execFile` mock and make the
// answer depend on what the host has installed. Pin it suite-wide to a host with
// only the legacy `sim-remote` on PATH. test/argent-cloud-bin.test.ts opts back
// in to the real module with vi.unmock.
vi.mock("../../src/utils/argent-cloud-bin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/argent-cloud-bin")>();
  const { commandOnPath } = await import("../../src/utils/command-on-path");
  return {
    ...actual,
    findArgentCloudBin: async () => ((await commandOnPath("sim-remote")) ? "sim-remote" : null),
    argentCloudBin: async () => "sim-remote",
    argentCloudCommand: () => "sim-remote",
    argentCloudVersion: async () => null,
  };
});
