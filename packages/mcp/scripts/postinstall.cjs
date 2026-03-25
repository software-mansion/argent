#!/usr/bin/env node
// @ts-check
"use strict";

// Runs automatically after `npm install @software-mansion/argent`.
// Set ARGENT_SKIP_POSTINSTALL=1 to suppress this message.

if (process.env.ARGENT_SKIP_POSTINSTALL === "1") {
  process.exit(0);
}

console.log(`
@software-mansion/argent installed.

To configure your workspace (MCP server, skills, rules), run:

  npx @software-mansion/argent install
`);

