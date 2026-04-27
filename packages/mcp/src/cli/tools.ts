import { fetchTool, fetchTools } from "./tools-client.js";
import { formatSchemaUsage, type JsonSchema } from "./flag-parser.js";

function summarize(description: string | undefined, max = 80): string {
  if (!description) return "";
  const firstLine = description.split("\n", 1)[0]!.trim();
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1).trimEnd() + "…";
}

async function listTools(json: boolean): Promise<void> {
  const tools = await fetchTools();
  if (json) {
    console.log(JSON.stringify(tools, null, 2));
    return;
  }

  if (tools.length === 0) {
    console.log("(no tools registered)");
    return;
  }

  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
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

export async function tools(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const sub = positional[0];

  if (!sub) {
    await listTools(json);
    return;
  }

  if (sub === "describe") {
    const name = positional[1];
    if (!name) {
      console.error("Usage: argent tools describe <tool-name>");
      process.exit(1);
    }
    await describeTool(name, json);
    return;
  }

  if (sub === "--help" || sub === "-h") {
    console.log(`Usage:
  argent tools                       List available tools
  argent tools describe <name>       Show one tool's flags and description

Options:
  --json                             Print machine-readable JSON
`);
    return;
  }

  console.error(`Unknown subcommand: tools ${sub}`);
  process.exit(1);
}
