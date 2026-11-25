import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs scripts/resolve-sim-server-release-tag.sh against a fake `gh` that
// serves a synthetic release list. Real gh applies --jq with its built-in jq,
// so the fake pipes the data through the jq binary with the same filter.
// `release list` gets tagName and publishedAt; `release view <tag>` gets the
// release's assets, given as names (uploaded) or as { name, state } objects.

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "resolve-sim-server-release-tag.sh"
);
const hasJq = spawnSync("jq", ["--version"]).status === 0;

const sha = (c) => c.repeat(40);

// Every asset download-simulator-server.sh asks the resolver for.
const ASSETS = [
  "simulator-server-argent-macos",
  "simulator-server-argent-linux",
  "simulator-server-argent-linux-arm64",
  "simulator-server-argent-windows.exe",
  "screen-sharing-agent.tar.gz",
];

function resolve(channel, releases, { ghExit = 0, viewExit = 0, assets = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-sim-server-"));
  try {
    writeFileSync(path.join(dir, "releases.json"), JSON.stringify(releases));
    // Fails on any call but the two the script is expected to make.
    writeFileSync(
      path.join(dir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${dir}/calls"
[[ "${ghExit}" == 0 ]] || { echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2; exit ${ghExit}; }
JQ=""
for ((i = 1; i < $#; i++)); do [[ "\${!i}" == "--jq" ]] && { j=$((i + 1)); JQ="\${!j}"; }; done
[[ -n "$JQ" ]] || { echo "missing --jq" >&2; exit 98; }
case "$1 $2" in
  "release list")
    jq '[.[] | {tagName, publishedAt}]' "${dir}/releases.json" | jq -r "$JQ" ;;
  "release view")
    [[ "${viewExit}" == 0 ]] || { echo "HTTP 502: Bad Gateway" >&2; exit ${viewExit}; }
    REL="$(jq --arg t "$3" '.[] | select(.tagName == $t)
      | {assets: [(.assets // [])[] | if type == "string" then {name: ., state: "uploaded"} else . end]}' \
      "${dir}/releases.json")"
    [[ -n "$REL" ]] || { echo "release not found" >&2; exit 1; }
    jq -r "$JQ" <<<"$REL" ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`
    );
    chmodSync(path.join(dir, "gh"), 0o755);
    const args = channel === undefined ? [SCRIPT] : [SCRIPT, channel, ...assets];
    const res = spawnSync("bash", args, {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const callsFile = path.join(dir, "calls");
    const ghCalls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : [];
    return {
      status: res.status,
      stdout: res.stdout.trim(),
      stderr: res.stderr,
      ghArgs: ghCalls[0] ?? "",
      ghCalls,
    };
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

test("skips a newest release that lacks a required asset", opts, () => {
  const res = resolve(
    "main",
    [
      {
        tagName: `radon-main-${sha("b")}`,
        publishedAt: "2026-11-23T12:00:00Z",
        assets: ASSETS.filter((a) => a !== "simulator-server-argent-linux"),
      },
      { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-23T09:00:00Z", assets: ASSETS },
    ],
    { assets: ASSETS }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `radon-main-${sha("a")}`);
  assert.match(
    res.stderr,
    new RegExp(`Skipping radon-main-${sha("b")}: missing simulator-server-argent-linux$`, "m")
  );
});

test("checks candidates newest first and stops at the first complete one", opts, () => {
  const res = resolve(
    "main",
    [
      { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-21T10:00:00Z", assets: ASSETS },
      { tagName: `radon-main-${sha("c")}`, publishedAt: "2026-11-23T10:00:00Z", assets: [] },
      { tagName: `radon-main-${sha("b")}`, publishedAt: "2026-11-22T10:00:00Z", assets: ASSETS },
      { tagName: `radon-daily-${sha("d")}`, publishedAt: "2026-11-24T10:00:00Z", assets: ASSETS },
    ],
    { assets: ASSETS }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `radon-main-${sha("b")}`);
  assert.deepEqual(
    res.ghCalls.slice(1).map((c) => c.split(" ")[2]),
    [`radon-main-${sha("c")}`, `radon-main-${sha("b")}`]
  );
  for (const call of res.ghCalls.slice(1)) {
    assert.match(
      call,
      /^release view \S+ --repo software-mansion-labs\/simulator-server-releases --json assets /
    );
  }
});

test("treats an asset that is still uploading as missing", opts, () => {
  const res = resolve(
    "main",
    [
      {
        tagName: `radon-main-${sha("b")}`,
        publishedAt: "2026-11-23T12:00:00Z",
        assets: ASSETS.map((name) =>
          name === "simulator-server-argent-windows.exe" ? { name, state: "open" } : name
        ),
      },
      { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-23T09:00:00Z", assets: ASSETS },
    ],
    { assets: ASSETS }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `radon-main-${sha("a")}`);
  assert.match(res.stderr, /missing simulator-server-argent-windows\.exe/);
});

test("matches asset names exactly, not as substrings or patterns", opts, () => {
  const res = resolve(
    "main",
    [
      {
        tagName: `radon-main-${sha("b")}`,
        publishedAt: "2026-11-23T12:00:00Z",
        // Has linux-arm64 but not linux, and a name that only a regex would match.
        assets: [
          "simulator-server-argent-macos",
          "simulator-server-argent-linux-arm64",
          "simulator-server-argent-windowsXexe",
          "screen-sharing-agent.tar.gz",
        ],
      },
    ],
    { assets: ASSETS }
  );
  assert.equal(res.status, 1);
  assert.match(
    res.stderr,
    /missing simulator-server-argent-linux simulator-server-argent-windows\.exe$/m
  );
});

test("fails with a clear error when no release has every required asset", opts, () => {
  const res = resolve(
    "daily",
    [
      {
        tagName: `radon-daily-${sha("b")}`,
        publishedAt: "2026-11-23T12:00:00Z",
        assets: ASSETS.slice(1),
      },
      {
        tagName: `radon-daily-${sha("a")}`,
        publishedAt: "2026-11-23T09:00:00Z",
        assets: ASSETS.slice(0, 4),
      },
    ],
    { assets: ASSETS }
  );
  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.match(
    res.stderr,
    /no radon-daily-<sha> release in software-mansion-labs\/simulator-server-releases has all of: simulator-server-argent-macos .* screen-sharing-agent\.tar\.gz/
  );
});

test("fails instead of skipping when a release's assets can't be read", opts, () => {
  const res = resolve(
    "main",
    [
      { tagName: `radon-main-${sha("b")}`, publishedAt: "2026-11-23T12:00:00Z", assets: ASSETS },
      { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-23T09:00:00Z", assets: ASSETS },
    ],
    { assets: ASSETS, viewExit: 1 }
  );
  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, new RegExp(`could not read the assets of radon-main-${sha("b")}`));
  assert.equal(res.ghCalls.length, 2);
});

test("without asset names, picks the newest release and never views assets", opts, () => {
  const res = resolve("main", [
    { tagName: `radon-main-${sha("b")}`, publishedAt: "2026-11-23T12:00:00Z", assets: [] },
    { tagName: `radon-main-${sha("a")}`, publishedAt: "2026-11-23T09:00:00Z", assets: ASSETS },
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `radon-main-${sha("b")}`);
  assert.equal(res.ghCalls.length, 1);
});
