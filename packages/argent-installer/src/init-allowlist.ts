import * as p from "@clack/prompts";
import pc from "picocolors";
import type { McpConfigAdapter } from "./mcp-configs.js";

interface AllowlistArgs {
  adapters: McpConfigAdapter[];
  effectiveRoot: string;
  scope: "local" | "global";
  nonInteractive: boolean;
}

export interface AllowlistResult {
  enabled: boolean;
  lines: string[];
}

export async function configureAllowlist({
  adapters,
  effectiveRoot,
  scope,
  nonInteractive,
}: AllowlistArgs): Promise<AllowlistResult> {
  const withApi = adapters.filter((a) => a.addAllowlist);
  const withoutApi = adapters.filter((a) => !a.addAllowlist);

  if (withApi.length === 0) return { enabled: false, lines: [] };

  p.log.info(
    `By default, editors ask for confirmation before running each MCP tool.\n` +
      `  Adding Argent to the auto-approve allowlist lets tools run without\n` +
      `  repeated prompts. This is ${pc.cyan("recommended")} for a smooth experience.`
  );

  let enabled = nonInteractive;
  if (!nonInteractive) {
    p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));
    const choice = await p.confirm({
      message: "Add Argent tools to editor auto-approve lists? - recommended",
      initialValue: true,
    });
    if (p.isCancel(choice)) {
      p.cancel("Initialization cancelled.");
      process.exit(0);
    }
    enabled = choice as boolean;
  }

  if (!enabled) return { enabled: false, lines: [] };

  const lines: string[] = [];
  for (const adapter of withApi) {
    const hasPath = scope === "global" ? adapter.globalPath() : adapter.projectPath(effectiveRoot);
    if (!hasPath) {
      lines.push(`${pc.yellow("-")} ${adapter.name} ${pc.dim("(no config for this scope)")}`);
      continue;
    }
    try {
      adapter.addAllowlist!(effectiveRoot, scope);
      lines.push(`${pc.green("+")} ${adapter.name}`);
    } catch (err) {
      lines.push(`${pc.red("x")} ${adapter.name}: ${pc.dim(String(err))}`);
    }
  }
  for (const adapter of withoutApi) {
    lines.push(
      `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no auto-approve API - configure manually)")}`
    );
  }
  return { enabled: true, lines };
}
