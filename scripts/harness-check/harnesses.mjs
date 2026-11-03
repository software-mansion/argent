/**
 * The harnesses harness-check.mjs runs, and how each one is pointed at the Argent server
 * and at a recorder for its model requests.
 *
 * Codex, opencode and Gemini CLI are installed at pinned versions into a cache folder and
 * talk to the local model stub, so they need no account. Claude Code and Kiro CLI are used
 * as installed on this machine, need a signed-in account, and talk to their real backend.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Pinned versions. Change one to check another release; see README.md. */
const PINS = {
  codex: { pkg: "@openai/codex", version: "0.164.0", bin: "codex" },
  opencode: { pkg: "opencode-ai", version: "1.19.4", bin: "opencode" },
  gemini: { pkg: "@google/gemini-cli", version: "0.65.0", bin: "gemini" },
};

/** The models the stub pretends to be. opencode treats keywords differently per provider. */
const OPENCODE_MODELS = [
  { id: "opencode-openai", label: "opencode (OpenAI model)", model: "openai/gpt-5.5" },
  {
    id: "opencode-google",
    label: "opencode (Google model)",
    model: "google/gemini-3.1-pro-preview",
  },
  {
    id: "opencode-anthropic",
    label: "opencode (Anthropic model)",
    model: "anthropic/claude-sonnet-4-5",
  },
];

export const DEFAULT_HARNESSES = ["codex", "opencode", "gemini"];
export const ACCOUNT_HARNESSES = ["claude", "kiro"];

/** The process groups of the commands still running. */
const running = new Set();

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Kills every command still running. Each one leads its own process group, which Ctrl-C
 * in the terminal does not reach, so the check calls this when it is interrupted.
 */
export function killRunning() {
  for (const pid of running) killGroup(pid);
}

/**
 * Runs a command and collects its output. On timeout the whole process group is killed,
 * which includes the Argent server the harness spawned.
 */
export function run(
  cmd,
  args,
  { env = process.env, cwd = process.cwd(), timeoutMs = 180_000 } = {}
) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    if (child.pid) running.add(child.pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      running.delete(child.pid);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      running.delete(child.pid);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

async function onPath(bin) {
  const r = await run("/bin/sh", ["-c", `command -v ${bin}`], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : "";
}

/** Installs a pinned CLI into the cache unless that exact version is there already. */
async function installPinned(id, cacheDir, log) {
  const pin = PINS[id];
  const dir = join(cacheDir, id);
  const bin = join(dir, "node_modules", ".bin", pin.bin);
  // Written only after a finished install, so an interrupted one is redone.
  const marker = join(dir, "installed-version");
  const installed = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  if (existsSync(bin) && installed === pin.version) return bin;
  log(`  installing ${pin.pkg}@${pin.version} into ${dir} (once per version)`);
  mkdirSync(dir, { recursive: true });
  const r = await run(
    "npm",
    [
      "install",
      "--prefix",
      dir,
      `${pin.pkg}@${pin.version}`,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { timeoutMs: 600_000 }
  );
  if (r.code !== 0 || !existsSync(bin))
    throw new Error(`Installing ${pin.pkg} failed:\n${r.stderr}`);
  writeFileSync(marker, pin.version);
  return bin;
}

/** A scratch HOME, so a harness reads and writes nothing in the user's own config. */
function scratchEnv(home, extra = {}) {
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    DO_NOT_TRACK: "1",
    ...extra,
  };
}

/**
 * The runs for the selected harnesses. Each run gets its own folder with a workspace,
 * the recorded requests, the harness output, and the Argent server's own log and HOME.
 * ctx: { repo, out, cacheDir, serverScript, stubUrl, proxyUrl, reference, claudeAllTools, log }
 */
export async function planRuns(ids, ctx) {
  /** @type {Array<Record<string, any>>} */
  const runs = [];
  const server = (runDir) => ({
    command: process.execPath,
    args: [
      ctx.serverScript,
      "--repo",
      ctx.repo,
      "--home",
      join(runDir, "server-home"),
      "--log",
      join(runDir, "server.log"),
    ],
  });
  const folders = (id) => {
    const dir = join(ctx.out, "runs", id);
    // A reused --out must not mix in requests from an earlier run.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // The same working directory in every check: Claude Code writes it into the prompt, so
    // token counts compare across checks only if it doesn't change.
    const workspace = join(tmpdir(), "argent-harness-check-workspace", id);
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    return { dir, workspace, requests: join(dir, "requests") };
  };
  const mcpJson = (runDir) => {
    const s = server(runDir);
    return JSON.stringify(
      { mcpServers: { argent: { command: s.command, args: s.args } } },
      null,
      2
    );
  };

  if (ids.includes("claude")) {
    const bin = await onPath("claude");
    if (!bin)
      throw new Error(
        "Claude Code (`claude`) is not on PATH. Install it and sign in, or drop `claude`."
      );
    const variants = [{ id: "claude", label: "Claude Code", allTools: false }];
    if (ctx.claudeAllTools)
      variants.push({
        id: "claude-all-tools",
        label: "Claude Code (all tools loaded)",
        allTools: true,
      });
    for (const v of variants) {
      const f = folders(v.id);
      const config = join(f.dir, "mcp.json");
      writeFileSync(config, mcpJson(f.dir));
      const deferred = ctx.reference.tools.filter((t) => !t._meta?.["anthropic/alwaysLoad"]);
      const select = deferred.map((t) => `mcp__argent__${t.name}`).join(",");
      const prompt = v.allTools
        ? `Call ToolSearch exactly once with query "select:${select}" and max_results 100. Do not call any other tool. Then reply with exactly: ok`
        : "Reply with exactly: ok";
      const args = [
        "-p",
        prompt,
        "--mcp-config",
        config,
        "--strict-mcp-config",
        "--output-format",
        "json",
      ];
      if (v.allTools) args.push("--allowedTools", "ToolSearch");
      runs.push({
        ...v,
        ...f,
        bin,
        args,
        env: { ...process.env, ANTHROPIC_BASE_URL: ctx.proxyUrl },
        via: "proxy",
        versionArgs: ["--version"],
        versionEnv: process.env,
      });
    }
  }

  if (ids.includes("codex")) {
    const bin = await installPinned("codex", ctx.cacheDir, ctx.log);
    const f = folders("codex");
    const home = join(f.dir, "home");
    mkdirSync(home, { recursive: true });
    const s = server(f.dir);
    writeFileSync(
      join(home, "config.toml"),
      [
        `model = "gpt-5.5"`,
        `model_provider = "harness_check"`,
        `[model_providers.harness_check]`,
        `name = "harness-check"`,
        `base_url = ${JSON.stringify(`${ctx.stubUrl}/v1`)}`,
        `wire_api = "responses"`,
        `env_key = "HARNESS_CHECK_KEY"`,
        `[mcp_servers.argent]`,
        `command = ${JSON.stringify(s.command)}`,
        `args = ${JSON.stringify(s.args)}`,
        "",
      ].join("\n")
    );
    // Every word of every tool name, so tool_search returns them all.
    const words = new Set(ctx.reference.tools.flatMap((t) => t.name.split("-")));
    // HOME too, not just CODEX_HOME: Codex also reads skills from ~/.agents/skills.
    const env = scratchEnv(home, { CODEX_HOME: home, HARNESS_CHECK_KEY: "x" });
    runs.push({
      id: "codex",
      label: "Codex",
      ...f,
      bin,
      args: ["exec", "--skip-git-repo-check", "Reply with ok"],
      env,
      via: "stub",
      codexToolSearch: [...words].join(" "),
      versionArgs: ["--version"],
      versionEnv: env,
    });
  }

  if (ids.includes("opencode")) {
    const bin = await installPinned("opencode", ctx.cacheDir, ctx.log);
    for (const m of OPENCODE_MODELS) {
      const f = folders(m.id);
      const s = server(f.dir);
      const config = join(f.dir, "opencode.json");
      const provider = (path) => ({ options: { baseURL: `${ctx.stubUrl}${path}`, apiKey: "x" } });
      writeFileSync(
        config,
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            provider: {
              openai: provider("/v1"),
              google: provider("/v1beta"),
              anthropic: provider("/v1"),
            },
            mcp: { argent: { type: "local", command: [s.command, ...s.args], enabled: true } },
            autoupdate: false,
            share: "disabled",
          },
          null,
          2
        )
      );
      const env = scratchEnv(join(f.dir, "home"), { OPENCODE_CONFIG: config });
      runs.push({
        id: m.id,
        label: m.label,
        ...f,
        bin,
        args: ["run", "--model", m.model, "Reply with ok"],
        env,
        via: "stub",
        versionArgs: ["--version"],
        versionEnv: env,
      });
    }
  }

  if (ids.includes("gemini")) {
    const bin = await installPinned("gemini", ctx.cacheDir, ctx.log);
    const f = folders("gemini");
    const home = join(f.dir, "home");
    const s = server(f.dir);
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      JSON.stringify(
        {
          mcpServers: { argent: { command: s.command, args: s.args } },
          security: { auth: { selectedType: "gemini-api-key" }, folderTrust: { enabled: false } },
          privacy: { usageStatisticsEnabled: false },
          general: { disableAutoUpdate: true },
        },
        null,
        2
      )
    );
    const env = scratchEnv(home, { GOOGLE_GEMINI_BASE_URL: ctx.stubUrl, GEMINI_API_KEY: "x" });
    runs.push({
      id: "gemini",
      label: "Gemini CLI",
      ...f,
      bin,
      // Without --approval-mode yolo, headless Gemini CLI sends no MCP tools at all.
      args: ["--approval-mode", "yolo", "-p", "Reply with ok", "-m", "gemini-3.1-pro-preview"],
      env,
      via: "stub",
      versionArgs: ["--version"],
      versionEnv: env,
    });
  }

  if (ids.includes("kiro")) {
    const bin = await onPath("kiro-cli");
    if (!bin)
      throw new Error(
        "Kiro CLI (`kiro-cli`) is not on PATH. Install it and sign in, or drop `kiro`."
      );
    const f = folders("kiro");
    mkdirSync(join(f.workspace, ".kiro", "settings"), { recursive: true });
    writeFileSync(join(f.workspace, ".kiro", "settings", "mcp.json"), mcpJson(f.dir));
    mkdirSync(f.requests, { recursive: true });
    runs.push({
      id: "kiro",
      label: "Kiro CLI",
      ...f,
      bin,
      args: [
        "chat",
        "--no-interactive",
        "--trust-tools=",
        "Reply with just the word ok. Do not call tools.",
      ],
      // Kiro CLI's own switch: it writes each request to this file.
      env: { ...process.env, KIRO_RECORD_API_REQUESTS_PATH: join(f.requests, "kiro-request.json") },
      via: "kiro",
      versionArgs: ["--version"],
      versionEnv: process.env,
    });
  }
  return runs;
}
