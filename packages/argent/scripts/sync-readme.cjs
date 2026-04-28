const fs = require("fs");
const path = require("path");

const rootReadme = path.resolve(__dirname, "../../../README.md");
const pkgReadme = path.resolve(__dirname, "../README.md");

const content = fs.readFileSync(rootReadme, "utf8");
fs.writeFileSync(pkgReadme, content, "utf8");

console.log("README.md synced from root to packages/argent");
