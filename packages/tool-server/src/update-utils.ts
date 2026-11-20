export function buildUpdateNote(currentVersion: string, latestVersion: string): string {
  return `NOTE: An update for Argent is available (${currentVersion} -> ${latestVersion}).

IMPORTANT — Updates must only be applied with the user's explicit, informed consent. Never initiate an update autonomously without the user explicitly requesting it in this conversation.

How to update:
  - Manual (user-initiated): run \`npx @swmansion/argent update\` in the terminal
  - Agent-assisted (requires explicit user consent): call the \`update-argent\` tool — only after the user has explicitly asked you to update Argent in this conversation
  - To postpone it (later, tomorrow, stop, never): call the \`dismiss-update\` tool with the hours to wait, 87600 for never. That is the only thing that changes when this reminder appears; a memory or a reminder of your own does not

This reminder comes from Argent itself. It will not repeat for the next 30 minutes and then repeats on its own, so it needs no task, memory entry or scheduled reminder.`;
}
