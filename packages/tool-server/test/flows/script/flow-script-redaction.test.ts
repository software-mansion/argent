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
const longRoots: string[] = [];

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
  while (longRoots.length) fs.rmSync(longRoots.pop()!, { recursive: true, force: true });
});

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("redact");
  workspaces.push(ws);
  return ws;
}

function executor(options: FlowScriptExecutorOptions = {}) {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

function envOf(secrets: readonly FlowScriptSecret[]): Record<string, string> {
  return Object.fromEntries(secrets.map(({ name, value }) => [name, value]));
}

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

/** A `bash` that refuses every call, quoting `$name` on stderr as it does. */
function refusingBash(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argent-bash-shim-"));
  longRoots.push(dir);
  const shim = path.join(dir, "bash");
  fs.writeFileSync(shim, `#!/bin/sh\necho "shim: no bash selected for $${name}" >&2\nexit 1\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

/**
 * `body` in a home of the test's own, with `scripts.bash` pinned in its global
 * document (the only scope the key takes) or `pathFirst` put first on PATH.
 */
async function inOwnHome<T>(
  setup: { bash?: string; pathFirst?: string },
  body: () => Promise<T>
): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "argent-redaction-home-"));
  const real = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
  };
  if (setup.bash) {
    fs.mkdirSync(path.join(home, ".argent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".argent", "config.json"),
      JSON.stringify({ scripts: { bash: setup.bash } }),
      "utf8"
    );
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (setup.pathFirst) process.env.PATH = `${setup.pathFirst}${path.delimiter}${real.PATH ?? ""}`;
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
 * so it reaches redaction by a channel a `.mjs` step does not have.
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

  function run(
    source: string,
    secrets: FlowScriptSecret[] = [SECRET],
    env: Record<string, string> = envOf(secrets)
  ) {
    const ws = workspace();
    return executor().execute({
      scriptPath: ws.write("step.sh", source),
      interpreter: "bash",
      projectRoot: ws.dir,
      env,
      secrets,
    });
  }

  it("replaces a secret the script wrote to stderr, in the reason and in the log", async () => {
    const result = await run(
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
      const tail = 2_000;
      // Ten characters short of the cap, written in three pieces.
      const source = `printf '%${STDERR_LINE_CHARS - 10}s' '' | tr ' ' 'x' >&2
         printf '%s' "$API_KEY" >&2
         printf '%${tail}s' '' | tr ' ' 'y' >&2
         echo >&2
         exit 5`;
      const pinned = longPath ? bashAtPathOfLength(hostBash, STDERR_LINE_CHARS) : undefined;
      const result = pinned
        ? await inOwnHome({ bash: pinned }, () => run(source))
        : await run(source);

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

  interface ReasonCase {
    label: string;
    source: string;
    secrets: FlowScriptSecret[];
    env?: Record<string, string>;
    tail: RegExp;
    hidden?: string[];
  }

  const PRINT_CREDS = `echo "could not parse credentials:" >&2
     echo "$AWS_CREDS" >&2
     exit 1`;
  const PEM: FlowScriptSecret = {
    name: "PEM",
    value:
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n" +
      "-----END PRIVATE KEY-----",
  };
  const LONG_KEY = Buffer.from("kyky".repeat(400)).toString("base64");

  /** Prints `line` to stderr with no line break, while a job holds stderr open. */
  function onOpenLine(line: string): string {
    return `( sleep 1 ) &
       printf '%s' "${line}" >&2
       exit 1`;
  }

  function overlapping(shape: string, line: string, other: string, printed: string): ReasonCase {
    const envFile = `DB_HOST=db.internal\n${line}\nAPI=x`;
    return {
      label: `hides both where a line of a multi-line secret ${shape}`,
      source: `echo "connect failed: $PRINTED" >&2
         exit 1`,
      secrets: [
        { name: "ENV_FILE", value: envFile },
        { name: "OTHER", value: other },
      ],
      env: { ENV_FILE: envFile, OTHER: other, PRINTED: printed },
      tail: /\. connect failed: \{\{secret:ENV_FILE}}$/,
    };
  }

  function cutInside(
    shape: string,
    [a, b, printed]: [string, string, string],
    pad: number,
    omitted: number
  ): ReasonCase {
    return {
      label: `drops a whole value at the stderr line's cut ${shape}`,
      source: `printf '%${pad}s' '' | tr ' ' 'x' >&2
         printf '%s more\\n' '${printed}' >&2
         exit 1`,
      secrets: [
        { name: "A", value: a },
        { name: "B", value: b },
      ],
      tail: new RegExp(`x… \\[${omitted} more characters omitted]$`),
      hidden: ["SECRET", "Zq8mWp", "hunter2"],
    };
  }

  it.each<ReasonCase>([
    {
      label: "replaces a multi-line secret whose last line is the last stderr line",
      source: PRINT_CREDS,
      secrets: [
        {
          name: "AWS_CREDS",
          // With a line of spaces and blank lines in it, which are no line to match.
          value:
            "[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n   \n\n\n" +
            "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        },
      ],
      tail: /\(bash: .+\)\. \{\{secret:AWS_CREDS}}$/,
      hidden: ["AKIAIOSFODNN7", "wJalrXUtnFEMI"],
    },
    {
      label: "drops a line of a multi-line secret that the reason cut",
      source: PRINT_CREDS,
      secrets: [
        { name: "AWS_CREDS", value: `users:\n- name: dev\n    client-key-data: ${LONG_KEY}` },
      ],
      tail: /\(bash: .+\)\. … \[\d+ more characters omitted]$/,
      hidden: [LONG_KEY.slice(0, 8)],
    },
    ...[
      ["whitespace at both ends", "  hunter2-staging  "],
      ["a final line break", "hunter2-staging\n"],
    ].map(([shape, value]): ReasonCase => ({
      label: `replaces a secret with ${shape}, which the line's split or trim would cut`,
      source: `printf '%s\\n' "$PASS" >&2
           exit 1`,
      secrets: [{ name: "PASS", value }],
      tail: /\(bash: .+\)\. \{\{secret:PASS}}$/,
      hidden: ["hunter2-staging"],
    })),
    {
      label: "replaces a secret with whitespace at both ends that ends a line a job holds open",
      source: onOpenLine("login rejected for password: $PASS"),
      secrets: [{ name: "PASS", value: " hunter2-both " }],
      tail: /\. login rejected for password: \{\{secret:PASS}}$/,
      hidden: ["hunter2-both"],
    },
    {
      label: "keeps the quote a line a job holds open ends on, beside a multi-line secret",
      source: onOpenLine("error: cannot open 'config.yaml'"),
      secrets: [PEM],
      tail: /\. error: cannot open 'config\.yaml'$/,
    },
    {
      label: "drops the front of a secret the stderr line was still being written on",
      source: `(
           printf 'fatal: bad token %s' "\${API_KEY:0:8}" >&2
           for i in $(seq 1 40); do echo "tick $i"; sleep 0.05; done
           printf '%s\\n' "\${API_KEY:8}" >&2
         ) &
         sleep 0.1
         exit 3`,
      secrets: [SECRET],
      tail: /\. fatal: bad token … \[8 more characters omitted]$/,
      hidden: [SECRET.value.slice(0, 4)],
    },
    {
      label: "walks up from a runtime's version line the stderr line was still being written on",
      source: `(
           printf 'Error: bad token %s\\n    at main (/app/seed.js:3:9)\\n\\nNode.js v26.7.0' "$API_KEY" >&2
           sleep 2
         ) &
         sleep 0.1
         exit 3`,
      // Starts with the version's last character, which the open line ends on.
      secrets: [{ name: "API_KEY", value: "0bad-token-value" }],
      tail: /\. Error: bad token \{\{secret:API_KEY}}$/,
      hidden: ["0bad-token"],
    },
    overlapping(
      "ends with the front of another",
      "export DB_PASS=hunter2",
      "hunter2-staging-9981",
      "export DB_PASS=hunter2-staging-9981"
    ),
    overlapping(
      "holds another whole",
      "DB_URL=postgres://svc_admin:Zq8mWp2vLx9@db/app",
      "svc_admin",
      "DB_URL=postgres://svc_admin:Zq8mWp2vLx9@db/app"
    ),
    {
      label: "replaces a line of a multi-line secret that holds a quote, as set -x quoted it",
      source: `set -x
         test "$SQ_FILE" = expected`,
      secrets: [{ name: "SQ_FILE", value: "DB_HOST=db.internal\nDB_PASS=it's-Zq8mWp2vLx9" }],
      tail: /\{\{secret:SQ_FILE}}' = expected$/,
      hidden: ["Zq8mWp2vLx9"],
    },
    // The front of B is cut, and A runs into it.
    cutInside(
      "that runs into the front of another",
      ["SECRET-ABC", "ABC-123456", "SECRET-ABC-123456"],
      987,
      22
    ),
    // A ends at the cut, inside the front of B.
    cutInside(
      "inside the front of a longer one",
      ["hunter2-9981", "Zq8mWp-hunter2-9981-prod", "Zq8mWp-hunter2-9981-prod"],
      981,
      29
    ),
    {
      label: "counts the half of a character the stderr line's cut split",
      source: `printf '%999s' '' | tr ' ' 'x' >&2
         printf '\\xf0\\x9f\\x98\\x80' >&2
         printf '%10s\\n' '' | tr ' ' 'y' >&2
         exit 1`,
      secrets: [SECRET],
      tail: /x… \[12 more characters omitted]$/,
    },
  ])(
    "$label",
    async ({ source, secrets, env, tail, hidden = [] }) => {
      const result = await run(source, secrets, env);

      const message = result.failure?.message ?? "";
      expect(result.failure?.kind).toBe("exit");
      expect(message).toMatch(tail);
      for (const text of hidden) expect(message).not.toContain(text);
    },
    30_000
  );

  it("reads the secret set at the verdict, so a value added after bash exited still redacts", async () => {
    const secrets: FlowScriptSecret[] = [];
    const pending = run(
      `( sleep 1 ) &
       echo "fatal: token $LATE rejected" >&2
       exit 2`,
      secrets,
      { LATE: "late-value-bbbb" }
    );
    setTimeout(() => secrets.push({ name: "LATE", value: "late-value-bbbb" }), 300);

    expect((await pending).failure?.message).toMatch(/\. fatal: token \{\{secret:LATE}} rejected$/);
  }, 30_000);

  it("quotes no window of the output document back", async () => {
    const result = await run(`printf '%s' "$API_KEY" > "$ARGENT_OUTPUT"`);

    expect(result.failure?.message).toContain("is not valid JSON");
    expect(result.failure?.message).not.toContain(SECRET.value.slice(0, 6));
  }, 30_000);

  const onPosix = it.skipIf(process.platform === "win32");
  const SHIM_STDERR = "(it wrote to stderr: shim: no bash selected for {{secret:API_KEY}})";

  onPosix(
    "replaces a secret a refused scripts.bash wrote to stderr, in the refusal",
    async () => {
      const result = await inOwnHome({ bash: refusingBash("API_KEY") }, () => run("exit 0"));

      expect(result.failure?.kind).toBe("spawn");
      expect(result.failure?.message).toContain(SHIM_STDERR);
      expect(result.failure?.message).not.toContain(SECRET.value);
    },
    30_000
  );

  onPosix(
    "replaces a secret a refused bash on PATH wrote to stderr, in the note of the step that ran",
    async () => {
      const shim = refusingBash("API_KEY");
      const result = await inOwnHome({ pathFirst: path.dirname(shim) }, () => run("exit 0"));

      const notes = result.notes.join(" ");
      expect(result.ok).toBe(true);
      expect(notes).toContain(`${shim} is not a bash`);
      expect(notes).toContain(SHIM_STDERR);
      expect(notes).not.toContain(SECRET.value);
    },
    30_000
  );

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
  // This file runs on the Windows job, where Node reports a real exhaustion as
  // exit code 134 and no signal.
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

/** The `.mjs` cases `flow-script-logs.test.ts` does not already make through the log. */
describe("flow script executor — redaction of a .mjs failure", () => {
  const SECRET: FlowScriptSecret = { name: "API_KEY", value: "s3cr3t-token-value" };
  const DB_USER: FlowScriptSecret = { name: "DB_USER", value: "dbadmin" };
  const DATABASE_URL: FlowScriptSecret = {
    name: "DATABASE_URL",
    value: "postgres://dbadmin:Sup3rS3cretPw@db.internal:5432/prod",
  };

  function runMjs(
    source: string,
    secrets: FlowScriptSecret[],
    env: Record<string, string> = envOf(secrets)
  ) {
    const ws = workspace();
    return executor().execute({
      scriptPath: ws.write("step.mjs", source),
      projectRoot: ws.dir,
      env,
      secrets,
    });
  }

  it("leaves the output document as the script wrote it, at any depth and in a key", async () => {
    const result = await runMjs(
      `const key = process.env.API_KEY;
       output.session = { token: key, scopes: ["read", key] };
       output[key] = "keyed";`,
      [SECRET]
    );

    expect(result.output).toEqual({
      [SECRET.value]: "keyed",
      session: { token: SECRET.value, scopes: ["read", SECRET.value] },
    });
  }, 30_000);

  it("keeps two concurrent runs' secret lists apart", async () => {
    const source = `await new Promise((r) => setTimeout(r, 300));
       throw new Error("saw " + process.env.MINE);`;
    const [a, b] = await Promise.all(
      ["FIRST", "SECOND"].map((name) => {
        const value = `value-of-the-${name.toLowerCase()}-run`;
        return runMjs(source, [{ name, value }], { MINE: value });
      })
    );

    expect(a.failure?.message).toBe("saw {{secret:FIRST}}");
    expect(b.failure?.message).toBe("saw {{secret:SECOND}}");
  }, 30_000);

  it("keeps a message the scrub grew inside the ceiling the child applied", async () => {
    const result = await runMjs(`throw new Error("7".repeat(20000) + " tail");`, [
      { name: "PIN", value: "7" },
    ]);

    const message = result.failure?.message ?? "";
    expect(message).toContain("{{secret:PIN}}");
    expect(message.length).toBeLessThanOrEqual(SCRIPT_MAX_FAILURE_MESSAGE_CHARS);
  }, 30_000);

  // The child clamps with no secret list, here about nine characters into the
  // value. A secret of "0" also occurs in the marker's count, which is argent's.
  it("keeps a secret that straddles the failure-message ceiling out of the report, whatever the marker holds", async () => {
    const source = `throw new Error(
       "p".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - 41) + process.env.API_KEY + "t".repeat(1000)
     );`;
    const alone = await runMjs(source, [SECRET]);
    const withPin = await runMjs(source, [SECRET, { name: "PIN", value: "0" }]);

    const markerOf = (text: string) => text.slice(text.lastIndexOf("… ["));
    for (const { failure } of [alone, withPin]) {
      expect(failure?.kind).toBe("runtime");
      expect(failure?.message).not.toContain(SECRET.value.slice(0, 4));
      expect(failure?.stack).not.toContain(SECRET.value.slice(0, 8));
    }
    expect(markerOf(alone.failure?.message ?? "")).toMatch(
      /^… \[\d*0\d* more characters omitted]$/
    );
    expect(markerOf(withPin.failure?.message ?? "")).toBe(markerOf(alone.failure?.message ?? ""));
  }, 30_000);

  it("drops the whole front of a cut value that holds another secret", async () => {
    const source = `throw new Error(
       "p".repeat(${SCRIPT_MAX_FAILURE_MESSAGE_CHARS} - 62) + process.env.DATABASE_URL + "t".repeat(1000)
     );`;
    const env = envOf([DB_USER, DATABASE_URL]);

    const control = (await runMjs(source, [], env)).failure?.message ?? "";
    expect(control).toContain("postgres://dbadmin:");
    expect(control).not.toContain(DATABASE_URL.value);

    const message = (await runMjs(source, [DB_USER, DATABASE_URL])).failure?.message ?? "";
    expect(message).toMatch(/p… \[\d+ more characters omitted]$/);
    expect(message).not.toContain("{{secret:");
  }, 30_000);

  it("replaces an encoded value that holds another secret, whole", async () => {
    const result = await runMjs(
      `const url = encodeURIComponent(process.env.DATABASE_URL);
       console.log("connect " + url);
       throw new Error("connect failed: " + url);`,
      [DB_USER, DATABASE_URL]
    );

    expect(result.failure?.message).toBe("connect failed: {{secret:DATABASE_URL}}");
    expect(result.log).toBe("connect {{secret:DATABASE_URL}}\n");
  }, 30_000);

  const FLAT: FlowScriptSecret = { name: "FLAT", value: "sk-live-9d3f-topvalue" };
  const PEM: FlowScriptSecret = {
    name: "PEM",
    value:
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA1234\n-----END PRIVATE KEY-----",
  };
  const ENCODED = [
    FLAT,
    PEM,
    { name: "QUOTED", value: 'pa"ss\\word' },
    { name: "SPACED", value: "Bearer sk-live-9d3f" },
  ];
  /** The part of each value no window of the report may hold six characters of. */
  const MATERIAL: Record<string, string> = {
    FLAT: FLAT.value,
    PEM: "MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA1234",
    QUOTED: 'pa"ss\\word',
    SPACED: "sk-live-9d3f",
  };

  it.each([
    [
      "the runner's own JSON encoder",
      `throw new Error("request failed", { cause: { status: 401, key: process.env.K } });`,
    ],
    [
      "a URL, percent-encoded or with a space as +,",
      `const u = new URL("https://api.example.com/x");
       u.searchParams.set("t", process.env.K);
       throw new Error("call failed: " + u.toString());`,
    ],
  ])(
    "replaces a value %s wrote",
    async (_, source) => {
      for (const secret of ENCODED) {
        const { failure } = await runMjs(source, ENCODED, { K: secret.value });

        const text = `${failure?.message ?? ""}\n${failure?.stack ?? ""}`;
        expect(text).toContain(`{{secret:${secret.name}}}`);
        const part = MATERIAL[secret.name]!;
        for (let at = 0; at + 6 <= part.length; at += 1) {
          expect(text).not.toContain(part.slice(at, at + 6));
        }
      }
    },
    60_000
  );

  it("leaves hex-, base64- and percent-shaped text that holds no value alone", async () => {
    const line =
      "deadbeefcafe0123 aGVsbG8gd29ybGQ= GET https://api.example.com/v1/search" +
      "?q=caf%C3%A9+menu%20P%40ss&page=1%2C2 returned 500 (100%25 of retries)";
    const result = await runMjs(
      `console.log(${JSON.stringify(line)});
       throw new Error(${JSON.stringify(line)});`,
      [FLAT, { name: "PW", value: "P@ss w0rd~2026!" }]
    );

    expect(result.log).toBe(`${line}\n`);
    expect(result.failure?.message).toBe(line);
  }, 30_000);
});
