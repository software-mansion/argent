import { createToolsClient, type ToolsServerPaths } from "@argent/tools-client";
import { parseCommandArgs, UsageError, type OptionSpecs } from "./command-args.js";
import { formatSchemaUsage, type JsonSchema } from "./flag-parser.js";

export interface ToolsCommandOptions {
  paths: ToolsServerPaths;
}

function summarize(description: string | undefined, max = 80): string {
  if (!description) return "";
  const firstLine = description.split("\n", 1)[0]!.trim();
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1).trimEnd() + "…";
}

const TOOLS_OPTIONS = {
  json: { kind: "boolean" },
  help: { kind: "boolean", alias: "h" },
} as const satisfies OptionSpecs;

export async function tools(argv: string[], options: ToolsCommandOptions): Promise<void> {
  const { fetchTool, fetchTools } = createToolsClient({ paths: options.paths });

  async function listTools(json: boolean): Promise<void> {
    const list = await fetchTools();
    if (json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }

    if (list.length === 0) {
      console.log("(no tools registered)");
      return;
    }

    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
    const maxName = sorted.reduce((m, t) => Math.max(m, t.name.length), 0);
    for (const t of sorted) {
      const summary = summarize(t.description);
      console.log(`  ${t.name.padEnd(maxName, " ")}  ${summary}`);
    }
    console.log(`\n${sorted.length} tools. Run \`argent tools describe <name>\` for details.`);
  }

  async function describeTool(name: string, json: boolean): Promise<void> {
    const meta = await fetchTool(name);
    if (!meta) {
      console.error(`Tool "${name}" not found. Run \`argent tools\` to list available tools.`);
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify(meta, null, 2));
      return;
    }
    console.log(`Tool: ${meta.name}\n`);
    if (meta.description) console.log(`${meta.description.trim()}\n`);
    console.log("Flags:");
    console.log(formatSchemaUsage(meta.inputSchema as JsonSchema));
    if (meta.outputHint) console.log(`\nOutput hint: ${meta.outputHint}`);
  }

  function printUsage(): void {
    console.log(`Usage:
  argent tools                       List available tools
  argent tools describe <name>       Show one tool's flags and description

Options:
  --json                             Print machine-readable JSON
  --help, -h                         Show this help

Listing tools contacts the argent tool-server, starting one if none is running.
`);
  }

  const usageError = (message: string): never => {
    console.error(`Error: ${message}\n`);
    printUsage();
    process.exit(2);
  };
  let parsed: ReturnType<typeof parseCommandArgs>;
  try {
    parsed = parseCommandArgs(argv, TOOLS_OPTIONS);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return usageError(err.message);
  }
  const [sub, name, extra] = parsed.positionals;
  const json = parsed.options.json === true;

  // `argent tools describe <name> --help` asks for that tool's flags, which
  // describeTool prints.
  if (parsed.options.help === true && !(sub === "describe" && name !== undefined)) {
    printUsage();
    return;
  }

  if (!sub) {
    await listTools(json);
    return;
  }

  if (sub === "describe") {
    if (!name) {
      console.error("Usage: argent tools describe <tool-name>");
      process.exit(1);
    }
    if (extra !== undefined) usageError(`Unexpected argument "${extra}"`);
    await describeTool(name, json);
    return;
  }

  console.error(`Unknown subcommand: tools ${sub}`);
  process.exit(1);
}
