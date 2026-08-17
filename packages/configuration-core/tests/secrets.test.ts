import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  secretSources,
  lookupSecret,
  secretNames,
  describeSecretSources,
  secretPlacementAdvice,
  type SecretSourceOptions,
} from "../src/secrets.js";

// Sandbox both scopes, as config-access.test.ts does: `homeDir` for the global
// `~/.argent/secrets.env`, `cwd` for the project root (a tmp dir seeded with a
// `.git` marker so the project-root walk-up stops there). Without this the
// developer's real files would decide the result.
let homeDir: string;
let projectDir: string;
let options: SecretSourceOptions;

/** Environment with nothing exposed, so file behavior is what is under test. */
const NO_ENV: NodeJS.ProcessEnv = { PATH: "/bin" };

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const projectSecrets = () => path.join(projectDir, ".argent", "secrets.env");
const globalSecrets = () => path.join(homeDir, ".argent", "secrets.env");

/** Resolve one name through the whole chain. */
function get(name: string, env: NodeJS.ProcessEnv = NO_ENV): string | undefined {
  return lookupSecret(name, secretSources({ ...options, env }));
}

function names(env: NodeJS.ProcessEnv = NO_ENV): string[] {
  return secretNames(secretSources({ ...options, env }));
}

beforeEach(() => {
  homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-home-")));
  projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-project-")));
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  options = { cwd: projectDir, homeDir };
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("environment source", () => {
  it("exposes prefixed variables, without the prefix", () => {
    expect(get("APP_PASSWORD", { ARGENT_SECRET_APP_PASSWORD: "hunter2" })).toBe("hunter2");
  });

  it("ignores everything unprefixed", () => {
    expect(get("APP_PASSWORD", { APP_PASSWORD: "hunter2" })).toBeUndefined();
    expect(names({ GITHUB_TOKEN: "ghp_x" })).toEqual([]);
  });

  it("exposes an empty value as a defined (empty) secret", () => {
    expect(get("BLANK", { ARGENT_SECRET_BLANK: "" })).toBe("");
  });
});

describe("dedicated secrets files", () => {
  it("exposes every key in the project file", () => {
    write(projectSecrets(), "APP_PASSWORD=from-project\nAPP_USER=tester\n");
    expect(get("APP_PASSWORD")).toBe("from-project");
    expect(names()).toEqual(["APP_PASSWORD", "APP_USER"]);
  });

  it("exposes every key in the global file, which needs no project", () => {
    write(globalSecrets(), "APP_PASSWORD=from-home\n");
    const detached = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-detached-")));
    expect(
      lookupSecret("APP_PASSWORD", secretSources({ cwd: detached, homeDir, env: NO_ENV }))
    ).toBe("from-home");
    fs.rmSync(detached, { recursive: true, force: true });
  });

  it("accepts a redundant ARGENT_SECRET_ prefix on a key", () => {
    write(projectSecrets(), "ARGENT_SECRET_APP_PASSWORD=prefixed\n");
    expect(get("APP_PASSWORD")).toBe("prefixed");
  });

  it("honors the dotenv grammar", () => {
    write(
      projectSecrets(),
      ["export EXPORTED=exported", 'QUOTED="pa ss=word#1"', "TRAILING=x # comment"].join("\n")
    );
    expect(get("EXPORTED")).toBe("exported");
    expect(get("QUOTED")).toBe("pa ss=word#1");
    expect(get("TRAILING")).toBe("x");
  });

  it("drops keys no placeholder could reference", () => {
    write(projectSecrets(), "with.dot=x\nwith-dash=y\nOK=z\n");
    expect(names()).toEqual(["OK"]);
  });
});

describe("files the app shares", () => {
  it("exposes only ARGENT_SECRET_-prefixed keys from .env", () => {
    write(
      path.join(projectDir, ".env"),
      "STRIPE_SECRET_KEY=sk_live_x\nARGENT_SECRET_APP_PASSWORD=from-dotenv\n"
    );
    expect(get("APP_PASSWORD")).toBe("from-dotenv");
    // The app's own config in the same file is not reachable through a
    // placeholder — the prefix is the allowlist, exactly as in the environment.
    expect(get("STRIPE_SECRET_KEY")).toBeUndefined();
    expect(names()).toEqual(["APP_PASSWORD"]);
  });

  it("reports a shared file that exists but exposes nothing", () => {
    write(path.join(projectDir, ".env"), "STRIPE_SECRET_KEY=sk_live_x\n");
    const sources = secretSources({ ...options, env: NO_ENV });
    const dotenv = sources.find((s) => s.label === path.join(projectDir, ".env"))!;
    expect(dotenv.present).toBe(true);
    expect(dotenv.needsPrefix).toBe(true);
    expect(describeSecretSources(sources)).toContain("only prefixed keys are exposed");
  });
});

describe("precedence", () => {
  it("resolves nearest-first: env, .argent/secrets.env, .env.local, .env, then home", () => {
    write(globalSecrets(), "NAME=home\n");
    expect(get("NAME")).toBe("home");

    write(path.join(projectDir, ".env"), "ARGENT_SECRET_NAME=dotenv\n");
    expect(get("NAME")).toBe("dotenv");

    write(path.join(projectDir, ".env.local"), "ARGENT_SECRET_NAME=dotenv-local\n");
    expect(get("NAME")).toBe("dotenv-local");

    write(projectSecrets(), "NAME=project\n");
    expect(get("NAME")).toBe("project");

    expect(get("NAME", { ARGENT_SECRET_NAME: "env" })).toBe("env");
  });

  it("falls through a source that does not define the name", () => {
    write(projectSecrets(), "OTHER=x\n");
    write(globalSecrets(), "APP_PASSWORD=from-home\n");
    expect(get("APP_PASSWORD")).toBe("from-home");
  });

  it("unions names across sources, sorted and deduplicated", () => {
    write(projectSecrets(), "B=1\nA=2\n");
    write(globalSecrets(), "A=3\nC=4\n");
    expect(names({ ARGENT_SECRET_D: "5" })).toEqual(["A", "B", "C", "D"]);
  });
});

describe("degradation", () => {
  it("treats a missing file as an absent source", () => {
    const sources = secretSources({ ...options, env: NO_ENV });
    const project = sources.find((s) => s.label === projectSecrets())!;
    expect(project.present).toBe(false);
    expect(project.names).toEqual([]);
    expect(describeSecretSources(sources)).toContain("not found");
  });

  it("survives a secrets file that is a directory", () => {
    fs.mkdirSync(projectSecrets(), { recursive: true });
    write(globalSecrets(), "APP_PASSWORD=from-home\n");
    expect(get("APP_PASSWORD")).toBe("from-home");
  });

  it("skips project sources when the cwd is not inside a project", () => {
    const detached = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argent-detached-")));
    const sources = secretSources({ cwd: detached, homeDir, env: NO_ENV });
    expect(sources.map((s) => s.label)).toEqual(["environment (ARGENT_SECRET_*)", globalSecrets()]);
    fs.rmSync(detached, { recursive: true, force: true });
  });

  it("lists a file shared by both scopes once", () => {
    // A project rooted at the home directory: its `.argent/secrets.env` and the
    // global one are the same file.
    fs.mkdirSync(path.join(homeDir, ".git"), { recursive: true });
    write(globalSecrets(), "APP_PASSWORD=shared\n");
    const sources = secretSources({ cwd: homeDir, homeDir, env: NO_ENV });
    expect(sources.filter((s) => s.label === globalSecrets())).toHaveLength(1);
    expect(lookupSecret("APP_PASSWORD", sources)).toBe("shared");
  });
});

describe("diagnostics", () => {
  it("describes each source without disclosing a value", () => {
    write(projectSecrets(), "APP_PASSWORD=hunter2\n");
    const description = describeSecretSources(secretSources({ ...options, env: NO_ENV }));
    expect(description).toContain(`${projectSecrets()} — found, 1 secret`);
    expect(description).toContain(`${globalSecrets()} — not found`);
    expect(description).not.toContain("hunter2");
  });

  it("advises the global file first, since it needs no project discovery", () => {
    const advice = secretPlacementAdvice("APP_PASSWORD", options);
    expect(advice).toContain(globalSecrets());
    expect(advice).toContain("ARGENT_SECRET_APP_PASSWORD");
    expect(advice).toContain("never ask the user for the secret value itself");
  });
});
