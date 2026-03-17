# Installing Argent

Argent is distributed as `@software-mansion-labs/argent` via [GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

Because the source repository is **private**, you must authenticate with GitHub before you can download the package. Follow the steps below.

---

## Prerequisites

- Node.js 18 or later
- A GitHub account with read access to `software-mansion-labs/radon-lite`
- macOS with Xcode installed (Argent controls iOS Simulators)

---

## Step 1 — Create a GitHub Personal Access Token (PAT)

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**.
2. Click **Generate new token (classic)**.
3. Give it a descriptive note (e.g. `argent-install`).
4. Select the **`read:packages`** scope. No other scopes are required.
5. Click **Generate token** and copy the value — you will not see it again.

> If your organisation enforces SSO, click **Configure SSO** next to the token and authorise `software-mansion-labs`.

---

## Step 2 — Authenticate with GitHub Packages

Add the following line to your **global** `~/.npmrc` file (create it if it does not exist). Replace `YOUR_GITHUB_TOKEN` with the PAT from Step 1.

```
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

Alternatively, use `npm login`:

```bash
npm login --registry=https://npm.pkg.github.com --scope=@software-mansion-labs
# Username: your GitHub username
# Password: your PAT (NOT your GitHub account password)
# Email:    your GitHub email
```

> Keep your token out of version control. Never commit `.npmrc` files that contain tokens.

---

## Step 3 — Install Argent in your project

Navigate to the root of the project where you want to use Argent (your iOS app, React Native project, etc.) and run:

```bash
npx @software-mansion-labs/argent install
```

The CLI will:
- Install `@software-mansion-labs/argent` from GitHub Packages into `node_modules`
- Register the MCP server in `.claude/mcp.json`, `.cursor/mcp.json`, and `.mcp.json`
- Add the `mcp__argent` permission entry to `.claude/settings.json`
- Copy skills, agents, and rules into `.claude/` and `.cursor/rules/`

---

## Updating

To pull the latest version and refresh all workspace files:

```bash
npx @software-mansion-labs/argent update
```

---

## Removing

To unregister the MCP server and uninstall the package:

```bash
npx @software-mansion-labs/argent remove
```

Pass `--prune` to also delete the copied `.claude/skills`, `.claude/agents`, and rules directories:

```bash
npx @software-mansion-labs/argent remove --prune
```

---

## Troubleshooting

### `npm ERR! code E401` or `npm ERR! 401 Unauthorized`

Your token is missing or incorrect. Re-check your `~/.npmrc` entry or run `npm login` again (Step 2).

### `npm ERR! code E403` or `npm ERR! 403 Forbidden`

Your GitHub account does not have read access to `software-mansion-labs/radon-lite`, or SSO authorisation is missing. Contact the repository administrator.

### Token works locally but fails in CI

Pass the token as an environment variable and reference it from `.npmrc`:

```
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then set `GITHUB_TOKEN` in your CI environment secrets.
