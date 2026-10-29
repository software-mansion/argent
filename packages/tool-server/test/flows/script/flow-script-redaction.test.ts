import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptSecret,
} from "../../../src/tools/flows/script/flow-script-executor";
import { SCRIPT_MAX_FAILURE_MESSAGE_CHARS } from "../../../src/tools/flows/script/flow-script-protocol";
import { resolveHostBash } from "../../helpers/host-bash";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];
const longRoots: string[] = [];

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
  while (longRoots.length) fs.rmSync(longRoots.pop()!, { recursive: true, force: true });
});

/**
 * A second name for the host's bash, `chars` long, so the exit line in front
 * of the stderr reason is that long. Nested directories, because one path
 * component is capped at 255 bytes.
 */
function bashAtPathOfLength(bash: string, chars: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "argent-long-bash-"));
  longRoots.push(root);
  let dir = root;
  while (chars - dir.length - 1 > 255) dir = path.join(dir, "d".repeat(200));
  const link = path.join(dir, "b".repeat(chars - dir.length - 1));
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(bash, link);
  return link;
}

/** `scripts.bash` pinned in the global document of a home of the test's own. */
async function withPinnedBash<T>(bash: string, body: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-redaction-home-"));
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".argent", "config.json"),
    JSON.stringify({ scripts: { bash } }),
    "utf8"
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await body();
  } finally {
    for (const [name, previous] of Object.entries(real)) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * A bash step's failure text ends with a line the script wrote to stderr,
 * which the parent reads off the pipe and appends to the runner's exit line,
 * so it reaches redaction by a channel a `.mjs` step does not have. The `.mjs`
 * redaction cases are in `flow-script-logs.test.ts`.
 */
describe("flow script executor — redaction of a bash step", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };
  /** `STDERR_REASON_LINE_CHARS` in `flow-script-executor.ts`, which does not export it. */
  const STDERR_LINE_CHARS = 1_000;

  let noBash: string | undefined;
  let hostBash = "";

  beforeAll(async () => {
    const found = await resolveHostBash();
    if ("path" in found) hostBash = found.path;
    else noBash = found.problem;
  });

  beforeEach((ctx) => {
    if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
  });

  function run(ws: ScriptWorkspace, name: string, source: string) {
    return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000 }).execute({
      scriptPath: ws.write(name, source),
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });
  }

  function workspace(): ScriptWorkspace {
    const ws = createScriptWorkspace("redact");
    workspaces.push(ws);
    return ws;
  }

  it("replaces a secret the script wrote to stderr, in the reason and in the log", async () => {
    const result = await run(
      workspace(),
      "reason.sh",
      `printf 'the call to %s failed\\n' "$API_KEY" >&2
       exit 4`
    );

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).not.toContain(SECRET.value);
    expect(result.failure?.message).toContain("the call to {{secret:API_KEY}} failed");
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("the call to {{secret:API_KEY}} failed");
  }, 30_000);

  // The cut that keeps the head of a long stderr line lands INSIDE the secret,
  // leaving a prefix no whole-value scrub can match; the parent drops it with
  // the marker. A long interpreter path in the exit line in front must not move
  // that marker. The 1,000-character symlink is POSIX only.
  it.each([
    ["the host's bash", false],
    ...(process.platform === "win32" ? [] : [["a bash whose path is as long as the line", true]]),
  ] as [string, boolean][])(
    "drops the half of a secret the stderr line's cut left behind, under %s",
    async (_label, longPath) => {
      const ws = workspace();
      const tail = 2_000;
      // Ten characters short of the cap, written in three pieces.
      const source = `printf '%${STDERR_LINE_CHARS - 10}s' '' | tr ' ' 'x' >&2
         printf '%s' "$API_KEY" >&2
         printf '%${tail}s' '' | tr ' ' 'y' >&2
         echo >&2
         exit 5`;
      const pinned = longPath ? bashAtPathOfLength(hostBash, STDERR_LINE_CHARS) : undefined;
      const result = pinned
        ? await withPinnedBash(pinned, () => run(ws, "long-line.sh", source))
        : await run(ws, "long-line.sh", source);

      const message = result.failure?.message ?? "";
      expect(result.failure?.kind).toBe("exit");
      if (pinned) expect(message).toContain(pinned);
      expect(message.length).toBeLessThanOrEqual(SCRIPT_MAX_FAILURE_MESSAGE_CHARS);
      for (let n = SECRET.value.length; n > 3; n -= 1) {
        expect(message).not.toContain(SECRET.value.slice(0, n));
      }
      // The marker counts everything from the secret on.
      const marker = `x… [${SECRET.value.length + tail} more characters omitted]`;
      expect(message.slice(-marker.length)).toBe(marker);
      // The log keeps the whole line, and so the whole value to replace.
      expect(result.log).not.toContain(SECRET.value);
      expect(result.log).toContain("x{{secret:API_KEY}}y");
    },
    30_000
  );
});
