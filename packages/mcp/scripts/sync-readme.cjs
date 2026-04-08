const fs = require('fs');
const path = require('path');

const rootReadme = path.resolve(__dirname, '../../../README.md');
const mcpReadme = path.resolve(__dirname, '../README.md');

const content = fs.readFileSync(rootReadme, 'utf8');
fs.writeFileSync(mcpReadme, content, 'utf8');

console.log('README.md synced from root to packages/mcp');