export function buildUpdateNote(currentVersion: string, latestVersion: string): string {
  return `NOTE: An update for Argent is available (${currentVersion} -> ${latestVersion}).

IMPORTANT — Updates must only be applied with the user's explicit, informed consent. Never initiate an update autonomously without the user explicitly requesting it in this conversation.

How to update:
  - Manual (user-initiated): run \`npx @swmansion/argent update\` in the terminal
  - Agent-assisted (requires explicit user consent): call the \`update-argent\` tool — only after the user has explicitly asked you to update Argent in this conversation
  - To postpone this reminder: call the \`dismiss-update\` tool with the number of hours to suppress it

ACTION REQUIRED: Save a note (via TODO, task list, or memory) that an Argent update to v${latestVersion} is available so you can remind the user about it later. This notification will not repeat for the next 30 minutes.`;
}
