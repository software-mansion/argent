## 1. Install in the target project

```bash
cd /path/to/your-project
npm install /path/to/software-mansion-argent-0.3.1.tgz
```

Use `--force` flag if needed.

## 2. Configure the workspace

```bash
npx argent install --local
```

The above command:
- Writes MCP server entries to `.claude/mcp.json`, `.cursor/mcp.json`, `.mcp.json`
- Adds `mcp__argent` permission to `.claude/settings.json`
- Copies skills, agents, and rules into `.claude/` and `.cursor/`

## Updating

To update from a newer tarball, repeat steps 1–3. The `--local` flag
will re-run configuration with whatever version is in `node_modules`.


## Usage

Launch your coding agent of choice (Claude, Cursor CLI) - argent mcp server and relevant skills should be visible. After that, simply ask the agent to perform actions on iOS simulator.

NOTE: the binary or console, where argent runs, may require and prompt you for additional accessibility permissions at this stage of development. This will be changed in the future, to allow for frictionless develpoment.