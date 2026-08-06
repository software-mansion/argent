import * as p from "@clack/prompts";
import pc from "picocolors";
import type { McpConfigAdapter } from "./mcp-configs.js";
import { InitCancelled } from "./init-args.js";

export interface AllowlistResult {
  enabled: boolean;
  lines: string[];
}

// Tool auto-approval step. Returns whether allowlisting was enabled (so the
// orchestrator can emit allowlist_decision) and the per-adapter summary lines.
// Throws InitCancelled("allowlist") on cancel.
export async function configureAllowlist(args: {
  adapters: McpConfigAdapter[];
  effectiveRoot: string;
  scope: "local" | "global";
  nonInteractive: boolean;
  /** --no-allowlist: skip writing editor auto-approve lists */
  noAllowlist?: boolean;
}): Promise<AllowlistResult> {
  const { adapters, effectiveRoot, scope, nonInteractive, noAllowlist } = args;
  const adaptersWithAllowlist = adapters.filter((a) => a.addAllowlist);
  const adaptersWithoutAllowlist = adapters.filter((a) => !a.addAllowlist);

  let enabled = false;

  if (noAllowlist) {
    p.log.info(
      pc.dim(
        "Skipped editor auto-approve allowlists (--no-allowlist). " +
          "Use Cursor/editor Run Everything if you want tools unprompted."
      )
    );
    return { enabled: false, lines: [] };
  }

  if (adaptersWithAllowlist.length > 0) {
    const hasCursor = adaptersWithAllowlist.some((a) => a.name === "Cursor");
    p.log.info(
      `By default, editors ask for confirmation before running each MCP tool.\n` +
        `  Adding Argent to the auto-approve allowlist lets tools run without\n` +
        `  repeated prompts. This is ${pc.cyan("recommended")} for a smooth experience.` +
        (hasCursor
          ? `\n\n  ${pc.yellow("Cursor note:")} writing ~/.cursor/permissions.json with only\n` +
            `  ${pc.cyan("argent:*")} enables MCP allowlist mode — other MCP servers will still\n` +
            `  prompt. If you use Cursor "allow all" / Run Everything, choose ${pc.cyan("No")}\n` +
            `  (or pass ${pc.cyan("--no-allowlist")}).`
          : "")
    );

    if (nonInteractive) {
      enabled = true;
    } else {
      p.log.message(pc.dim("  Press y for yes, n for no, enter to confirm."));

      const allowlistChoice = await p.confirm({
        message: "Add Argent tools to editor auto-approve lists? - recommended",
        initialValue: true,
      });

      if (p.isCancel(allowlistChoice)) throw new InitCancelled("allowlist");
      enabled = allowlistChoice as boolean;
    }
  }

  if (!enabled) return { enabled, lines: [] };

  const lines: string[] = [];

  for (const adapter of adaptersWithAllowlist) {
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

  for (const adapter of adaptersWithoutAllowlist) {
    lines.push(
      `${pc.yellow("-")} ${adapter.name} ${pc.dim("(no auto-approve API - configure manually)")}`
    );
  }

  return { enabled, lines };
}
