# Argent CLI

The `argent` command is the primary interface for installing, configuring, and
managing argent in your development environment.

## Installation

### 1. Configure the scoped registry (one-time setup)

`@software-mansion/argent` is hosted on GitHub Packages. You need to tell your
package manager to fetch `@software-mansion/*` packages from there while keeping
the default npmjs.org registry for everything else.

Add these lines to your **global** `~/.npmrc`:

```ini
@software-mansion:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<GITHUB_PAT>
```

Replace `<GITHUB_PAT>` with a GitHub Personal Access Token that has the
`read:packages` scope. Alternatively, use `npm login`:

```bash
npm login --registry=https://npm.pkg.github.com --scope=@software-mansion
```

> **Why not `--registry`?** The `--registry` CLI flag overrides the default
> registry for *all* packages, including third-party dependencies like
> `picocolors` that don't exist on GitHub Packages. Using a scoped registry in
> `.npmrc` ensures only `@software-mansion/*` goes through GitHub Packages while
> dependencies resolve from npmjs.org as usual.

### 2. Install globally

```bash
# npm
npm install -g @software-mansion/argent

# pnpm
pnpm add -g @software-mansion/argent

# yarn
yarn global add @software-mansion/argent
```

After installation, the `argent` command is available in your terminal.

## Commands

| Command | Description |
|---------|-------------|
| `argent init` | Set up argent in a workspace (MCP server, skills, rules) |
| `argent update` | Check for updates, upgrade the package, refresh config |
| `argent uninstall` | Remove argent configuration and optionally the package |
| `argent bridge` | (Future) Execute tool-server commands via CLI |

### Global options

| Option | Description |
|--------|-------------|
| `--help`, `-h` | Show help |
| `--version`, `-v` | Print the installed version |

---

## `argent init`

Interactive setup wizard that configures the MCP server, installs skills, and
copies rules/agents to your editor directories.

```bash
argent init
```

### What it does

1. **Detects your editors** -- checks for Cursor, Claude Code, VS Code,
   Windsurf, and Zed. Asks which to configure (all detected are pre-selected).
2. **Asks for scope** -- global (writes to `~/.cursor/mcp.json`,
   `~/.claude.json`, etc.) or local (writes to `.cursor/mcp.json`, `.mcp.json`,
   etc. in the current project).
3. **Writes MCP server entries** -- each editor gets the correct config format
   (see [Supported editors](#supported-editors) below). Claude Code also gets
   the `mcp__argent` permission.
4. **Installs skills** via [`npx skills`](https://github.com/vercel-labs/skills)
   with three options:
   - **Default (recommended)** -- runs `npx skills add <path> --skill '*' -y`
     automatically. Scope is inferred from the MCP scope choice.
   - **Interactive** -- hands off to the full `npx skills` TUI so you can pick
     individual skills, editors, and installation method.
   - **Manual** -- prints the bundled skills path and copy commands.
5. **Copies rules and agents** -- `argent.md` rule and agent definitions are
   placed in the correct directories for your selected editors, using the same
   scope as the MCP configuration.

### Non-interactive mode

```bash
argent init --yes
# or
argent init -y
```

Skips all prompts. Uses all detected editors, global scope, and default skills
installation.

---

## `argent update`

Checks whether a newer version of the package is available, upgrades it, and
refreshes all workspace configuration.

```bash
argent update
```

### What it does

1. Compares installed version against the latest on the registry.
2. If outdated, asks to upgrade (runs the appropriate global install command for
   your package manager).
3. Refreshes MCP config entries for all detected editors (both local and global).
4. Re-copies rules and agents.
5. Optionally runs `npx skills check` to see if installed skills have updates.

### Non-interactive mode

```bash
argent update --yes
```

Upgrades without confirmation and skips the skills check prompt.

---

## `argent uninstall`

Removes argent configuration from your workspace.

```bash
argent uninstall
```

### What it does

1. Removes the `argent` MCP server entry from all editor configs (both local
   and global).
2. Removes the `mcp__argent` permission from Claude Code settings.
3. Optionally prunes skills, rules, and agents directories.
4. Optionally runs `npx skills remove --all` for thorough skills cleanup.
5. Optionally uninstalls the global package itself.

### Options

| Option | Description |
|--------|-------------|
| `--yes`, `-y` | Skip all confirmation prompts |
| `--prune` | Also remove skills, rules, and agents directories |

### Examples

```bash
# Interactive -- asks before each step
argent uninstall

# Remove everything without prompts
argent uninstall --yes --prune
```

---

## `argent bridge`

> **Not yet implemented.** This is a stub for future functionality.

The bridge will allow the MCP server to execute tool-server commands through the
CLI instead of via HTTP. See [`docs/cli-bridge-guide.md`](./cli-bridge-guide.md)
for the planned architecture.

---

## Supported editors

The CLI writes the correct MCP configuration format for each editor:

| Editor | Config key | `type` field | Project config | Global config |
|--------|-----------|-------------|---------------|--------------|
| Cursor | `mcpServers` | not needed | `.cursor/mcp.json` | `~/.cursor/mcp.json` |
| Claude Code | `mcpServers` | `"stdio"` | `.mcp.json` | `~/.claude.json` |
| VS Code | `servers` | `"stdio"` | `.vscode/mcp.json` | n/a |
| Windsurf | `mcpServers` | not needed | n/a | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `context_servers` | `"custom"` (source) | `.zed/settings.json` | `~/.config/zed/settings.json` |

The MCP entry uses `argent-mcp` as the command, which is available on your PATH
after global installation. This makes the configuration portable across machines
and package managers.

---

## CI / Scripting

All commands support `--yes` / `-y` for non-interactive use.

Configure the scoped registry first (typically via an `.npmrc` file in the CI
environment or environment variables):

```bash
# Set up scoped registry (CI)
echo "@software-mansion:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> ~/.npmrc

# Full setup
npm install -g @software-mansion/argent
argent init --yes

# Teardown
argent uninstall --yes --prune
```

---

## Troubleshooting

### `argent: command not found`

The package is not installed globally, or the global npm bin directory is not in
your PATH.

```bash
# Check where global bins are installed
npm bin -g

# Ensure that directory is in your PATH
export PATH="$(npm bin -g):$PATH"
```

### Skills installation fails

If `npx skills` is unavailable or network-restricted, use the manual option
during `argent init` and copy skills from the bundled directory:

```bash
# Find the bundled skills path
argent init   # choose "Manual" when prompted
```

### MCP server not connecting

Verify the config was written correctly:

```bash
# Cursor
cat .cursor/mcp.json

# Claude Code
cat .mcp.json

# VS Code
cat .vscode/mcp.json
```

The `argent-mcp` command should be in your PATH:

```bash
which argent-mcp
```
