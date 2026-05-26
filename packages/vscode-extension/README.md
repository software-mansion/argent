# @argent/vscode-extension

VSCode extension that hosts the Argent preview UI (variant proposals + simulator
stream) inside an editor webview. The webview is a thin shell around the page
served by the running argent tool-server at `<url>/preview/`.

## Usage

1. Start a tool-server (e.g. `argent mcp` or `npm run start:tool-server` from
   the workspace root). The default URL is `http://127.0.0.1:3001`.
2. In VSCode, run **Argent: Open Preview** from the command palette.
3. Override the URL via the `argent.toolServerUrl` setting if your tool-server
   listens elsewhere.

## Development

```sh
cd packages/vscode-extension
npm install --workspaces=false  # if not already covered by the root install
npm run build                   # tsc → dist/extension.js
```

Open this folder in VSCode and press <kbd>F5</kbd> to launch an Extension
Development Host. Once it loads, run **Argent: Open Preview** from the host's
command palette.

To produce a `.vsix`:

```sh
npm run package
```
