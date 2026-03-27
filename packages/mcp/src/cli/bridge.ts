import pc from "picocolors";

export async function bridge(_args: string[]): Promise<void> {
  console.log(
    `\n${pc.yellow("argent bridge")} is not yet implemented.\n`,
  );
  console.log(
    "This command will allow the MCP server to execute tool-server",
  );
  console.log(
    "commands directly through the argent CLI instead of via HTTP.\n",
  );
  console.log(
    `See ${pc.cyan("docs/cli-bridge-guide.md")} for the planned architecture.\n`,
  );
  process.exit(0);
}
