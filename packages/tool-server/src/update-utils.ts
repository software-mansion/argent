// Like the what's-new note (argent-mcp/src/whats-new.ts), this opens with what
// the agent should do: a note that leads with warnings reads as background, and
// agents finish the task without passing it on.
export function buildUpdateNote(currentVersion: string, latestVersion: string): string {
  return `An Argent update is available (${currentVersion} -> ${latestVersion}). Ask the user if they want to update, then continue with their request.

Update only if the user asks you to in this conversation:
  - The user can run \`npx @swmansion/argent update\` in the terminal.
  - Or, once they ask, you can call the \`update-argent\` tool.
  - To postpone it (later, tomorrow, stop, never), call the \`dismiss-update\` tool with the hours to wait, 87600 for never. That is the only thing that changes when this reminder appears; a memory or a reminder of your own does not.

This reminder comes from Argent itself. It will not repeat for the next 30 minutes and then repeats on its own, so it needs no task, memory entry or scheduled reminder.`;
}
