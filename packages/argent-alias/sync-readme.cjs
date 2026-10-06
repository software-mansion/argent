// The alias ships the repository README under a short note that says what the
// `argent` package is, so its npm page reads like the @swmansion/argent one.
const fs = require("fs");
const path = require("path");

const rootReadme = path.resolve(__dirname, "../../README.md");
const pkgReadme = path.resolve(__dirname, "README.md");

const note = `> **Note:** \`argent\` is an alias for [\`@swmansion/argent\`](https://www.npmjs.com/package/@swmansion/argent), for use with \`npx\`: \`npx argent@latest init\` runs \`@swmansion/argent\` of the same version.
> To install argent globally, run \`npm install -g @swmansion/argent\`. The alias refuses global installs.

`;

fs.writeFileSync(pkgReadme, note + fs.readFileSync(rootReadme, "utf8"), "utf8");

console.log("README.md synced from root to packages/argent-alias");
