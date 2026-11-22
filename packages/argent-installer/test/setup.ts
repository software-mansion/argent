import { afterEach, expect, vi } from "vitest";

// Adapters resolve some config paths from XDG_CONFIG_HOME before homedir().
// Tests redirect homedir() to a tmp dir, so a developer's real XDG_CONFIG_HOME
// would otherwise point those writes at their actual config.
delete process.env.XDG_CONFIG_HOME;

// On Node 23.0 to 24.13.0 and 25.0 to 25.3, fs.rmSync looks through a link
// (nodejs/node#61020): it keeps a dangling link, and throws for a link to a
// directory unless `recursive` is set. Every other Node removes the link, so a
// test that only checks the link is gone passes there whichever call removed
// it. Each such call is recorded here, then runs as usual, and fails the test
// it happened in. Installer code removes a link with removePath.
const linksRmSyncWouldKeep = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  type Fs = typeof import("node:fs");
  const actual = await importOriginal<Fs & { default: Fs }>();
  const rmSync: Fs["rmSync"] = (target, options) => {
    if (actual.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      const linked = actual.statSync(target, { throwIfNoEntry: false });
      if (!linked || (linked.isDirectory() && !options?.recursive)) {
        linksRmSyncWouldKeep.push(String(target));
      }
    }
    actual.rmSync(target, options);
  };
  return { ...actual, default: { ...actual.default, rmSync }, rmSync };
});

afterEach(() => {
  expect(
    linksRmSyncWouldKeep.splice(0),
    "links given to fs.rmSync that some supported Node releases keep; use removePath"
  ).toEqual([]);
});
