# Installing Argent

## Default installation

```bash
npx @software-mansion/argent init
```

The CLI will walk you through installing the package globally, configuring the MCP server for your editor, and setting up skills, rules, and agents.

Alternatively, you may run:

```bash
npm i -g @software-mansion/argent
argent init
```

### .npmrc setup (required before first install)

Argent is distributed via GitHub Packages. Add the following to your **global** `~/.npmrc`:

```ini
@software-mansion:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<GITHUB_PAT>
```

To generate a `<GITHUB_PAT>`:

1. Go to **GitHub > Settings > Developer settings > Personal access tokens > Tokens (classic)**.
2. Create a token with the `**read:packages`** scope.
3. If your org enforces SSO, click **Configure SSO** and authorise `software-mansion`.

> Never commit `.npmrc` files containing tokens.

---

## Installation from a tarball

If you have a pre-built `.tgz` (e.g. from CI or `npm pack`):

```bash
npx @software-mansion/argent init --from ./software-mansion-argent-<version>.tgz
```

No registry auth is needed when installing from a local file.

```bash
npm i -g PATH_TO_TAR
argent init
```

---

## Updating / Removing

```bash
npx @software-mansion/argent update   # pull latest version and refresh workspace files
npx @software-mansion/argent remove   # unregister MCP server and uninstall (--prune to also delete skills/rules/agents)
```

---

## Caveat: `describe` tool and macOS Accessibility permissions

The `describe` tool reads the iOS Simulator's UI accessibility tree. On first use, macOS will require you to grant **Accessibility permission** to the `simulator-server` binary.

When this happens, Argent automatically opens System Settings and reveals the binary in Finder. To grant access:

1. In **System Settings > Privacy & Security > Accessibility**, click the **+** button.
2. Navigate to the `simulator-server` binary shown in the Finder window (or use **Cmd+Shift+G** and paste the path).
3. Toggle the switch **ON** for `simulator-server`.

The tool works immediately after granting permission — no restart needed.