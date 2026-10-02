#!/usr/bin/env node
// `argent` on npm is an alias for @swmansion/argent, so that `npx argent <command>`
// works. It runs the CLI of the @swmansion/argent version it pins, in this process.
const { pathToFileURL } = require("node:url");

import(pathToFileURL(require.resolve("@swmansion/argent/dist/cli.js")).href);
