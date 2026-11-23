import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs scripts/resolve-sim-server-release-tag.sh against a fake `gh` that
// prints a synthetic release list. Real gh applies --jq with its built-in jq,
// so the fake pipes the list through the jq binary with the same filter.

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "resolve-sim-server-release-tag.sh"
);
const hasJq = spawnSync("jq", ["--version"]).status === 0;

const sha = (c) => c.repeat(40);

function resolve(channel, releases, { ghExit = 0 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-sim-server-"));
  try {
    writeFileSync(path.join(dir, "releases.json"), JSON.stringify(releases));
    // Fails on any call but the one the script is expected to make.
    writeFileSync(
      path.join(dir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "${dir}/args"
[[ "${ghExit}" == 0 ]] || { echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2; exit ${ghExit}; }
[[ "$1 $2" == "release list" ]] || { echo "unexpected gh call: $*" >&2; exit 99; }
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--jq" ]]; then exec jq -r "$2" "${dir}/releases.json"; fi
  shift
done
echo "missing --jq" >&2
exit 98
`
    );
    chmodSync(path.join(dir, "gh"), 0o755);
    const args = channel === undefined ? [SCRIPT] : [SCRIPT, channel];
    const res = spawnSync("bash", args, {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const argsFile = path.join(dir, "args");
    const ghArgs = existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim() : "";
    return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr, ghArgs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const opts = { skip: hasJq ? false : "jq is not installed" };

test("picks the newest radon-main-<sha> by publishedAt, not list order", opts, () => {
  const res = resolve("main", [
    { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-20T10:00:00Z" },
    { tagName: `radon-main-${sha("b")}`, publishedAt: "2026-11-22T10:00:00Z" },
    { tagName: `radon-main-${sha("c")}`, publishedAt: "2026-11-21T10:00:00Z" },
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `radon-main-${sha("b")}`);
});

test("asks gh for published releases only, by repo, with publishedAt", opts, () => {
  const res = resolve("main", [
    { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-20T10:00:00Z" },
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.ghArgs, /^release list /);
  assert.match(res.ghArgs, /--repo software-mansion-labs\/simulator-server-releases/);
  assert.match(res.ghArgs, /--exclude-drafts/);
  assert.match(res.ghArgs, /--json tagName,publishedAt/);
});

test("ignores other channels, branches, versions, bare SHAs and floating tags", opts, () => {
  const newest = "2026-11-23T10:00:00Z";
  const res = resolve("main", [
    { tagName: "radon-main", publishedAt: newest },
    { tagName: `radon-daily-${sha("d")}`, publishedAt: newest },
    { tagName: `radon-main-fix-${sha("e")}`, publishedAt: newest },
    { tagName: `radon-${sha("f")}`, publishedAt: newest },
    { tagName: "radon-v1.20.0", publishedAt: newest },
    { tagName: `radon-main-${sha("a").slice(0, 39)}`, publishedAt: newest },
    { tagName: `radon-main-${sha("A")}`, publishedAt: newest },
    { tagName: `radon-main-${sha("a")}-rc`, publishedAt: newest },
    { tagName: `xradon-main-${sha("a")}`, publishedAt: newest },
    { tagName: `radon-main-${sha("1")}`, publishedAt: "2026-11-01T10:00:00Z" },
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `radon-main-${sha("1")}`);
});

test("resolves the daily channel", opts, () => {
  const res = resolve("daily", [
    { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-23T10:00:00Z" },
    { tagName: `radon-daily-${sha("b")}`, publishedAt: "2026-11-22T03:00:00Z" },
    { tagName: `radon-daily-${sha("c")}`, publishedAt: "2026-11-21T03:00:00Z" },
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `radon-daily-${sha("b")}`);
});

test("fails with a clear error when the channel has no release", opts, () => {
  const res = resolve("main", [
    { tagName: "radon-main", publishedAt: "2026-02-04T11:30:20Z" },
    { tagName: "radon-v1.20.0", publishedAt: "2026-10-23T15:54:16Z" },
  ]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.match(
    res.stderr,
    /no radon-main-<sha> release found in software-mansion-labs\/simulator-server-releases/
  );
});

test("fails with a clear error when the list is empty", opts, () => {
  const res = resolve("daily", []);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no radon-daily-<sha> release found/);
});

test("fails with a gh login hint when gh can't list releases", opts, () => {
  const res = resolve("main", [], { ghExit: 4 });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.match(
    res.stderr,
    /could not list the releases of software-mansion-labs\/simulator-server-releases/
  );
  assert.match(res.stderr, /gh auth login/);
});

test("requires a channel", opts, () => {
  const res = resolve(undefined, []);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /usage: .*<channel>/);
  assert.equal(res.ghArgs, "");
});

test("rejects a channel that would change the jq regex", opts, () => {
  for (const channel of ["ma.n", "main|daily", 'main"', "feat/x"]) {
    const res = resolve(channel, [
      { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-20T10:00:00Z" },
    ]);
    assert.equal(res.status, 1, channel);
    assert.match(res.stderr, /invalid channel/, channel);
    assert.equal(res.ghArgs, "", channel);
  }
});
