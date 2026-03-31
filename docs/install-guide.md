# Installing Argent

## From the GitHub Packages registry

### 1. Configure the scoped registry (one-time)

Add to your **global** `~/.npmrc`:

```ini
@software-mansion:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<GITHUB_PAT>
```

Replace `<GITHUB_PAT>` with a token generated in the step below.

### Generating a GitHub PAT

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)** ([direct link](https://github.com/settings/tokens)).
2. Click **Generate new token (classic)**.
3. Give it a descriptive name (e.g. `argent-install`).
4. Select the **`read:packages`** scope — no other scopes are needed.
5. Click **Generate token** and copy it immediately (it won't be shown again).
6. If the `software-mansion` org enforces SSO, click **Configure SSO** next to the token and authorise it for `software-mansion`.

### 2. Install and set up

```bash
npm install -g @software-mansion/argent
argent init
```

---

## From a local `.tar` file

If you have a pre-built tarball (e.g. from `npm pack` or a CI artifact):

```bash
npm install -g ./software-mansion-argent-0.3.1.tgz
argent init
```

Replace the filename with the actual tarball path. No registry configuration or auth token is needed — npm installs directly from the file.

---

## Verify

```bash
argent --version
which argent-mcp
```

Both commands should succeed. After `argent init`, your editor's MCP config will be set up automatically.
