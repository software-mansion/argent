import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptExecutorOptions,
  type FlowScriptSecret,
} from "../../../src/tools/flows/script/flow-script-executor";
import { SCRIPT_MAX_FAILURE_MESSAGE_CHARS } from "../../../src/tools/flows/script/flow-script-protocol";
import { resolveHostBash } from "../../helpers/host-bash";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("redact");
  workspaces.push(ws);
  return ws;
}

const longRoots: string[] = [];

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
  while (longRoots.length) fs.rmSync(longRoots.pop()!, { recursive: true, force: true });
});

/**
 * A second name for the host's bash, of a chosen length. The resolver reports
 * `scripts.bash` verbatim, so the length of the configured value is the length
 * of what rides in the exit line of every failure message. Nested directories
 * rather than one long name, because a single path component is capped at 255
 * bytes.
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

async function withSearchPathFirst<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-redaction-home-"));
  const real = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = `${dir}${path.delimiter}${real.PATH ?? ""}`;
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

function shimQuoting(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-shim-"));
  longRoots.push(dir);
  const shim = path.join(dir, "bash");
  fs.writeFileSync(shim, `#!/bin/sh\necho "shim: no bash selected for $${name}" >&2\nexit 1\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

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

function executor(options: FlowScriptExecutorOptions = {}) {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

describe("flow script executor — redaction of a bash step", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };
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

  it("replaces a secret the script wrote to stderr, in the reason and in the log", async () => {
    const ws = workspace();
    const script = ws.write(
      "reason.sh",
      `printf 'the call to %s failed\\n' "$API_KEY" >&2
       exit 4`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).not.toContain(SECRET.value);
    expect(result.failure?.message).toContain("the call to {{secret:API_KEY}} failed");
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("the call to {{secret:API_KEY}} failed");
  }, 30_000);

  const JWT: FlowScriptSecret = {
    name: "JWT",
    value:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkNJIFNlZWRlciIs" +
      "ImlhdCI6MTUxNjIzOTAyMn0.7Rk1bXkF0yGmQ2nYx4L8vW9sD7cT1eP6hZ5uA0o",
  };
  const KEY: FlowScriptSecret = { name: "KEY", value: "sk-live-51Hq7xK2mN9pR4tV8wY3zA6bC0dE" };
  const BASIC = Buffer.from(`api:${JWT.value}`)
    .toString("base64")
    .match(/.{1,76}/g)!;

  function stderrLines(lines: readonly string[]): string {
    return `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")} >&2
       exit 1`;
  }

  it("ends the reason with an unrelated last line when a secret came before it", async () => {
    const ws = workspace();
    const script = ws.write(
      "earlier.sh",
      `echo "using key $KEY" >&2
       echo "deploy failed: quota exceeded" >&2
       exit 1`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { KEY: KEY.value },
      secrets: [KEY],
    });

    expect(result.failure?.message).toMatch(
      /^The script exited with code 1 \(bash: .+\)\. deploy failed: quota exceeded$/
    );
    expect(result.log).toContain("using key {{secret:KEY}}\n");
  }, 30_000);

  it("leaves the last stderr line as written when the step has no secrets", async () => {
    const [first, ...rest] = BASIC;
    const ws = workspace();
    const script = ws.write(
      "basic-auth-plain.sh",
      stderrLines([`login failed (401) with Authorization: Basic ${first}`, ...rest])
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
    });

    const message = result.failure?.message ?? "";
    expect(message).toMatch(/^The script exited with code 1 \(bash: .+\)\. /);
    expect(message.slice(-(BASIC.at(-1)!.length + 3))).toBe(`). ${BASIC.at(-1)}`);
  }, 30_000);

  it("leaves the output document as the script wrote it", async () => {
    const ws = workspace();
    const script = ws.write(
      "document.sh",
      `printf '{"auth":"Bearer %s"}' "$API_KEY" > "$ARGENT_OUTPUT.t"
       mv "$ARGENT_OUTPUT.t" "$ARGENT_OUTPUT"`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ auth: `Bearer ${SECRET.value}` });
  }, 30_000);

  it("quotes no window of the output document back", async () => {
    const ws = workspace();
    const script = ws.write("bad-output.sh", `printf '%s' "$API_KEY" > "$ARGENT_OUTPUT"`);
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    const message = result.failure?.message ?? "";
    expect(message).toContain("did not parse");
    expect(message).toContain("is not valid JSON");
    expect(message).toContain("Unexpected token 's'");
    expect(message).not.toContain(SECRET.value.slice(0, 6));
  }, 30_000);

  it("drops the half of a secret the stderr line's cut left behind", async () => {
    const ws = workspace();
    const pad = STDERR_LINE_CHARS - 10;
    const tail = 2_000;
    const script = ws.write(
      "long-line.sh",
      `printf '%${pad}s' '' | tr ' ' 'x' >&2
       printf '%s' "$API_KEY" >&2
       printf '%${tail}s' '' | tr ' ' 'y' >&2
       echo >&2
       exit 5`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    const message = result.failure?.message ?? "";
    expect(result.failure?.kind).toBe("exit");
    for (let n = SECRET.value.length; n > 3; n -= 1) {
      expect(message).not.toContain(SECRET.value.slice(0, n));
    }
    const marker = `x… [${SECRET.value.length + tail} more characters omitted]`;
    expect(message.slice(-marker.length)).toBe(marker);
    expect(result.log).not.toContain(SECRET.value);
    expect(result.log).toContain("x{{secret:API_KEY}}y");
  }, 30_000);

  /**
   * The interpreter path rides in the exit line in front of the stderr line,
   * and it is the one term in the message nothing bounds. A ceiling it can push
   * the message past cuts the line's own marker off the end — the marker the
   * parent reads to find where the line was cut, and so where half a secret
   * may be left. This is the same straddling secret as above, under a bash
   * whose path is as long as the whole line the reason keeps: the marker at
   * the end must still be the line's own, counting the half it dropped.
   *
   * POSIX only. The path is a symlink of 1,000 characters, and Windows refuses
   * both without a per-machine opt-in.
   */
  it.skipIf(process.platform === "win32")(
    "keeps the stderr line's own marker when the interpreter path is long",
    async () => {
      const ws = workspace();
      const pinned = bashAtPathOfLength(hostBash, STDERR_LINE_CHARS);

      const pad = STDERR_LINE_CHARS - 10;
      const tail = 2_000;
      const script = ws.write(
        "long-line-long-bash.sh",
        `printf '%${pad}s' '' | tr ' ' 'x' >&2
         printf '%s' "$API_KEY" >&2
         printf '%${tail}s' '' | tr ' ' 'y' >&2
         echo >&2
         exit 5`
      );
      const result = await withPinnedBash(pinned, () =>
        executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
          env: { API_KEY: SECRET.value },
          secrets: [SECRET],
        })
      );

      const message = result.failure?.message ?? "";
      expect(result.failure?.kind).toBe("exit");
      expect(message).toContain(pinned);
      expect(message.length).toBeLessThanOrEqual(SCRIPT_MAX_FAILURE_MESSAGE_CHARS);
      const marker = `x… [${SECRET.value.length + tail} more characters omitted]`;
      expect(message.slice(-marker.length)).toBe(marker);
      for (let n = SECRET.value.length; n > 3; n -= 1) {
        expect(message).not.toContain(SECRET.value.slice(0, n));
      }
    },
    30_000
  );

  it.skipIf(process.platform === "win32")(
    "replaces a secret a refused scripts.bash wrote to stderr, in the refusal",
    async () => {
      const ws = workspace();
      const script = ws.write("never.sh", "exit 0");
      const result = await withPinnedBash(shimQuoting("API_KEY"), () =>
        executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
          env: { API_KEY: SECRET.value },
          secrets: [SECRET],
        })
      );

      const message = result.failure?.message ?? "";
      expect(result.failure?.kind).toBe("spawn");
      expect(message).toContain(
        "(it wrote to stderr: shim: no bash selected for {{secret:API_KEY}})"
      );
      expect(message).not.toContain(SECRET.value);
    },
    30_000
  );

  it.skipIf(process.platform === "win32")(
    "replaces a secret a refused bash on PATH wrote to stderr, in the note of the step that ran",
    async () => {
      const ws = workspace();
      const script = ws.write("ran.sh", "exit 0");
      const shim = shimQuoting("API_KEY");
      const result = await withSearchPathFirst(path.dirname(shim), () =>
        executor().execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
          env: { API_KEY: SECRET.value },
          secrets: [SECRET],
        })
      );

      const notes = result.notes.join(" ");
      expect(result.ok).toBe(true);
      expect(notes).toContain(`${shim} is not a bash`);
      expect(notes).toContain(
        "(it wrote to stderr: shim: no bash selected for {{secret:API_KEY}})"
      );
      expect(notes).not.toContain(SECRET.value);
    },
    30_000
  );

  it("drops the front of a secret the stderr line was still being written on", async () => {
    const ws = workspace();
    const script = ws.write(
      "half-line.sh",
      `(
         printf 'fatal: bad token %s' "\${API_KEY:0:8}" >&2
         for i in $(seq 1 40); do echo "tick $i"; sleep 0.05; done
         printf '%s\\n' "\${API_KEY:8}" >&2
       ) &
       sleep 0.1
       exit 3`
    );
    const result = await executor().execute({
      scriptPath: script,
      interpreter: "bash",
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    const message = result.failure?.message ?? "";
    expect(result.failure?.kind).toBe("exit");
    for (let n = SECRET.value.length; n > 3; n -= 1) {
      expect(message).not.toContain(SECRET.value.slice(0, n));
    }
    expect(message).toMatch(/\. fatal: bad token … \[8 more characters omitted]$/);
    expect(result.log).not.toContain(SECRET.value.slice(0, 8));
    expect(result.log).toContain("{{secret:API_KEY}}");
  }, 30_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "replaces a secret in the name of an entry the cleanup could not remove",
    async () => {
      const ws = workspace();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "argent-redaction-exchange-"));
      longRoots.push(root);
      const script = ws.write(
        "leave.sh",
        `d="$(dirname "$ARGENT_OUTPUT")/cache"
         mkdir -p "$d"
         : > "$d/session-$API_KEY"
         chmod 500 "$d"`
      );
      try {
        const result = await executor({ exchangeRoot: root }).execute({
          scriptPath: script,
          interpreter: "bash",
          projectRoot: ws.dir,
          env: { API_KEY: SECRET.value },
          secrets: [SECRET],
        });

        const notes = result.notes.join(" ");
        expect(result.ok).toBe(true);
        expect(notes).toContain("could not be removed");
        expect(notes).toContain("session-{{secret:API_KEY}}");
        expect(notes).not.toContain(SECRET.value);
      } finally {
        for (const entry of fs.readdirSync(root)) {
          const cache = path.join(root, entry, "cache");
          if (fs.existsSync(cache)) fs.chmodSync(cache, 0o700);
        }
      }
    },
    30_000
  );
});

describe("flow script executor — the heap verdict", () => {
  it("recognises a heap banner split across two pipe chunks", async () => {
    const ws = workspace();
    const script = ws.write(
      "split-heap.mjs",
      `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
       process.stderr.write("\\n<--- Last few GCs --->\\n\\nFATAL ERROR: Reached ");
       await wait(60);
       process.stderr.write("heap limit Allocation failed - JavaScript heap out of memory\\n");
       await wait(60);
       process.abort();`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 20_000,
    });

    expect(result.failure?.kind).toBe("heap");
    expect(result.failure?.message).toContain("64 MiB");
  }, 30_000);

  it("recognises a real heap exhaustion", async () => {
    const ws = workspace();
    const script = ws.write(
      "oom.mjs",
      `const held = []; for (;;) held.push("x".repeat(1024 * 1024));`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 20_000,
    });

    expect(result.failure?.kind).toBe("heap");
    expect(result.failure?.message).toContain("64 MiB");
  }, 30_000);
});

describe("flow script executor — redaction", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };

  it("replaces a secret written in one piece", async () => {
    const ws = workspace();
    const script = ws.write("plain.mjs", `throw new Error("auth: " + process.env.API_KEY);`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.message).toBe("auth: {{secret:API_KEY}}");
  });

  it("replaces a secret in the failure message and its stack", async () => {
    const ws = workspace();
    const script = ws.write(
      "assert.mjs",
      `import assert from "node:assert/strict";
       assert.equal("sk-live-WRONG", process.env.API_KEY);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).not.toContain(SECRET.value);
    expect(result.failure?.message).toContain("{{secret:API_KEY}}");
    expect(result.failure?.stack).not.toContain(SECRET.value);
  });

  it("keeps two concurrent runs' secret lists apart", async () => {
    const ws = workspace();
    const first: FlowScriptSecret = { name: "FIRST", value: "value-of-the-first-run" };
    const second: FlowScriptSecret = { name: "SECOND", value: "value-of-the-second-run" };
    const script = ws.write(
      "both.mjs",
      `await new Promise((r) => setTimeout(r, 300));
       throw new Error("saw " + process.env.MINE);`
    );
    const run = (secret: FlowScriptSecret) =>
      executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        env: { MINE: secret.value },
        secrets: [secret],
      });

    const [a, b] = await Promise.all([run(first), run(second)]);

    expect(a.failure?.message).toBe("saw {{secret:FIRST}}");
    expect(b.failure?.message).toBe("saw {{secret:SECOND}}");
  }, 30_000);

  it("keeps a message the scrub grew inside the ceiling the child applied", async () => {
    const pin: FlowScriptSecret = { name: "PIN", value: "7" };
    const ws = workspace();
    const script = ws.write("blowup.mjs", `throw new Error("7".repeat(20000) + " tail");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { PIN: pin.value },
      secrets: [pin],
    });

    const message = result.failure?.message ?? "";
    expect(message).toContain("{{secret:PIN}}");
    expect(message.length).toBeLessThanOrEqual(SCRIPT_MAX_FAILURE_MESSAGE_CHARS);
  }, 30_000);

  it("leaves the output document as the script wrote it, at any depth and in a key", async () => {
    const ws = workspace();
    const script = ws.write(
      "echo.mjs",
      `const key = process.env.API_KEY;
       output.session = { token: key, scopes: ["read", key] };
       output[key] = "keyed";`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      [SECRET.value]: "keyed",
      session: { token: SECRET.value, scopes: ["read", SECRET.value] },
    });
  });

  it("leaves a marker well formed when a value occurs inside another secret's name", async () => {
    const ws = workspace();
    const script = ws.write("marker.mjs", `throw new Error("value=Q");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "Q0", value: "Q" }],
    });

    expect(result.failure?.message).toBe("value={{secret:Q0}}");
  });

  it("leaves a marker well formed when two secrets swap name and value", async () => {
    const ws = workspace();
    const script = ws.write("swapped.mjs", `throw new Error("id=TOKEN_ABC and OKEN");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [
        { name: "TOKEN_ABC", value: "OKEN" },
        { name: "OKEN", value: "TOKEN_ABC" },
      ],
    });

    expect(result.failure?.message).toBe("id={{secret:OKEN}} and {{secret:TOKEN_ABC}}");
  });

  it("does not nest a placeholder that stands beside an escape", async () => {
    const Q: FlowScriptSecret = { name: "Q0", value: "Q" };
    const ws = workspace();
    const script = ws.write(
      "beside-escape.mjs",
      `const line = "value=" + process.env.K + "%2C next";
       console.log(line);
       throw new Error(line);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { K: Q.value },
      secrets: [Q],
    });

    expect(result.ok).toBe(false);
    const reason = `${result.failure?.message ?? ""}\n${result.failure?.stack ?? ""}`;
    expect(reason).toContain("value={{secret:Q0}}%2C next");
    expect(result.log).toContain("value={{secret:Q0}}%2C next");
    expect(reason).not.toContain("{{secret:{{secret:");
    expect(result.log).not.toContain("{{secret:{{secret:");
  }, 30_000);

  it("replaces a value that starts inside marker-shaped text the script wrote", async () => {
    const ws = workspace();
    const script = ws.write("echoed.mjs", `throw new Error("head {{secret:TOK}}TAIL tail");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [
        { name: "TOK", value: "tok" },
        { name: "V", value: "TOK}}TAIL" },
      ],
    });

    const message = result.failure?.message ?? "";
    expect(message).not.toContain("TOK}}TAIL");
    expect(message).toContain("{{secret:V}}");
  });

  it("replaces a nested secret as part of the value around it, and alone elsewhere", async () => {
    const ws = workspace();
    const host: FlowScriptSecret = { name: "HOST", value: "api.internal.example.com" };
    const url: FlowScriptSecret = {
      name: "URL",
      value: `https://${host.value}/tenant/9f3a0b1c2d3e4f50`,
    };
    const script = ws.write(
      "nested.mjs",
      `throw new Error(
         "calling " + ${JSON.stringify(url.value)} + " on " + ${JSON.stringify(host.value)});`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [host, url],
    });

    expect(result.failure?.message).toBe("calling {{secret:URL}} on {{secret:HOST}}");
  });

  it("replaces the longer of two secrets when the shorter one is its prefix", async () => {
    const ws = workspace();
    const prefix: FlowScriptSecret = { name: "PFX", value: "sk-" };
    const full: FlowScriptSecret = { name: "FULL", value: "sk-live-9d3f0a1b" };
    const script = ws.write("prefix.mjs", `throw new Error("tok sk-live-9d3f0a1b end");`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [prefix, full],
    });

    expect(result.failure?.message).toBe("tok {{secret:FULL}} end");
  });

  it("replaces every occurrence of a value that starts with its own tail", async () => {
    const ws = workspace();
    const value = "0123456789".repeat(4);
    const script = ws.write(
      "periodic.mjs",
      `throw new Error(${JSON.stringify(value)}.repeat(128));`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      secrets: [{ name: "P", value }],
    });

    const message = result.failure?.message ?? "";
    expect(message).not.toMatch(/[0-9]/);
    expect(message).toContain("{{secret:P}}");
  }, 30_000);

  it("keeps a secret that straddles the failure-message ceiling out of the report", async () => {
    const ws = workspace();
    const script = ws.write(
      "long-throw.mjs",
      `throw new Error(
         "p".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - 41) + process.env.API_KEY + "t".repeat(1000)
       );`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).not.toContain(SECRET.value.slice(0, 8));
    expect(result.failure?.message).toMatch(/… \[\d+ more characters omitted]$/);
    expect(result.failure?.stack).not.toContain(SECRET.value.slice(0, 8));
  });

  it("repairs the straddling cut even when another secret's value is in the marker", async () => {
    const ws = workspace();
    const PIN: FlowScriptSecret = { name: "PIN", value: "0" };
    const script = ws.write(
      "long-throw-pin.mjs",
      `throw new Error(
         "p".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - 41) + process.env.API_KEY + "t".repeat(1000)
       );`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value, PIN: PIN.value },
      secrets: [SECRET, PIN],
    });
    const control = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { API_KEY: SECRET.value },
      secrets: [SECRET],
    });

    expect(control.failure?.message).toMatch(/… \[\d*0\d* more characters omitted]$/);

    const message = result.failure?.message ?? "";
    for (let n = SECRET.value.length; n > 3; n -= 1) {
      expect(message).not.toContain(SECRET.value.slice(0, n));
    }
    expect(message).toMatch(/… \[\d+ more characters omitted]$/);
    expect(message.slice(message.lastIndexOf("… ["))).toBe(
      (control.failure?.message ?? "").slice((control.failure?.message ?? "").lastIndexOf("… ["))
    );
  });

  it("replaces an encoded value that holds another secret, whole", async () => {
    const ws = workspace();
    const user: FlowScriptSecret = { name: "DB_USER", value: "dbadmin" };
    const url: FlowScriptSecret = {
      name: "DATABASE_URL",
      value: "postgres://dbadmin:Sup3rS3cretPw@db.internal:5432/prod",
    };
    const script = ws.write(
      "nested.mjs",
      `const url = encodeURIComponent(process.env.DATABASE_URL);
       console.log("connect " + url);
       throw new Error("connect failed: " + url);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { DB_USER: user.value, DATABASE_URL: url.value },
      secrets: [user, url],
    });

    expect(result.failure?.message).toBe("connect failed: {{secret:DATABASE_URL}}");
    expect(result.log).toBe("connect {{secret:DATABASE_URL}}\n");
  });

  it("drops the whole front of a cut value that holds another secret", async () => {
    const ws = workspace();
    const user: FlowScriptSecret = { name: "DB_USER", value: "dbadmin" };
    const url: FlowScriptSecret = {
      name: "DATABASE_URL",
      value: "postgres://dbadmin:Sup3rS3cretPw@db.internal:5432/prod",
    };
    const script = ws.write(
      "nested-cut.mjs",
      `throw new Error(
         "p".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - 62) + process.env.DATABASE_URL + "t".repeat(1000)
       );`
    );
    const run = (secrets: FlowScriptSecret[]) =>
      executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        env: { DB_USER: user.value, DATABASE_URL: url.value },
        secrets,
      });

    const control = (await run([])).failure?.message ?? "";
    expect(control).toContain("postgres://dbadmin:");
    expect(control).not.toContain(url.value);

    const message = (await run([user, url])).failure?.message ?? "";
    expect(message).toMatch(/p… \[\d+ more characters omitted]$/);
    expect(message).not.toContain("{{secret:");
  });

  it("reads the secret set live, so a value added mid-run still redacts", async () => {
    const ws = workspace();
    const script = ws.write(
      "later.mjs",
      `await new Promise((r) => setTimeout(r, 150));
       throw new Error(process.env.EARLY + " then " + process.env.LATE);`
    );
    const secrets: FlowScriptSecret[] = [{ name: "EARLY", value: "early-value-aaaa" }];
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { EARLY: "early-value-aaaa", LATE: "late-value-bbbb" },
      secrets,
    });
    // Pushed from a later turn of the loop, after the step has read the set
    // once: pushing in the same turn as the call lands before `runOne` ever
    // looks, so an implementation that snapshotted the array once would pass.
    setTimeout(() => secrets.push({ name: "LATE", value: "late-value-bbbb" }), 60);
    const result = await pending;

    expect(result.failure?.message).toBe("{{secret:EARLY}} then {{secret:LATE}}");
  });
});

describe("flow script executor — redaction through an encoder", () => {
  const FLAT: FlowScriptSecret = { name: "FLAT", value: "sk-live-9d3f-topvalue" };
  const PEM: FlowScriptSecret = {
    name: "PEM",
    value:
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA1234\n-----END PRIVATE KEY-----",
  };
  const QUOTED: FlowScriptSecret = { name: "QUOTED", value: 'pa"ss\\word' };
  const SPACED: FlowScriptSecret = { name: "SPACED", value: "Bearer sk-live-9d3f" };
  const ALL = [FLAT, PEM, QUOTED, SPACED];

  const material: Record<string, string> = {
    FLAT: FLAT.value,
    PEM: "MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA1234",
    QUOTED: QUOTED.value,
    SPACED: "sk-live-9d3f",
  };

  function expectNoValue(text: string, secret: FlowScriptSecret): void {
    expect(text).toContain(`{{secret:${secret.name}}}`);
    const part = material[secret.name]!;
    for (let n = part.length; n >= 6; n -= 1) {
      for (let i = 0; i + n <= part.length; i += 1) {
        expect(text).not.toContain(part.slice(i, i + n));
      }
    }
  }

  async function failWith(source: string, secret: FlowScriptSecret): Promise<string> {
    const ws = workspace();
    const script = ws.write("encoded.mjs", source);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { K: secret.value },
      secrets: ALL,
    });
    expect(result.ok).toBe(false);
    return `${result.failure?.message ?? ""}\n${result.failure?.stack ?? ""}`;
  }

  it("replaces a value the runner's own JSON encoder wrote", async () => {
    for (const secret of ALL) {
      const text = await failWith(
        `throw new Error("request failed", { cause: { status: 401, key: process.env.K } });`,
        secret
      );
      expectNoValue(text, secret);
    }
  }, 60_000);

  it("replaces a value a URL percent-encoded, and one it wrote a space of as +", async () => {
    for (const secret of ALL) {
      const text = await failWith(
        `const u = new URL("https://api.example.com/x");
         u.searchParams.set("t", process.env.K);
         throw new Error("call failed: " + u.toString());`,
        secret
      );
      expectNoValue(text, secret);
    }
  }, 60_000);

  it("leaves hex- and base64-shaped prose that holds no value alone", async () => {
    const text = await failWith(
      `throw new Error("deadbeefcafe0123 aGVsbG8gd29ybGQ= ordinary words");`,
      FLAT
    );
    expect(text).toContain("deadbeefcafe0123 aGVsbG8gd29ybGQ= ordinary words");
    expect(text).not.toContain("{{secret:");
  }, 30_000);

  it("leaves percent-escaped text that holds no value alone", async () => {
    const PW: FlowScriptSecret = { name: "PW", value: "P@ss w0rd~2026!" };
    const line =
      "GET https://api.example.com/v1/search?q=caf%C3%A9+menu%20P%40ss&page=1%2C2 returned 500 (100%25 of retries)";
    const ws = workspace();
    const script = ws.write(
      "percent.mjs",
      `console.log(${JSON.stringify(line)});
       throw new Error(${JSON.stringify(line)});`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      env: { K: PW.value },
      secrets: [PW],
    });

    expect(result.ok).toBe(false);
    const reason = `${result.failure?.message ?? ""}\n${result.failure?.stack ?? ""}`;
    expect(reason).toContain(line);
    expect(result.log).toContain(line);
    expect(reason).not.toContain("{{secret:");
    expect(result.log).not.toContain("{{secret:");
  }, 30_000);
});
