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

From the workspace root:

```sh
npm install
npm run build -w @argent/vscode-extension   # tsc → dist/extension.js
```

The repo gitignores `.vscode/`, so create a local `.vscode/launch.json` to
enable F5 in this package (not committed):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"]
    }
  ]
}
```

Then open `packages/vscode-extension` in VSCode and press <kbd>F5</kbd> to
launch an Extension Development Host. Once it loads, run **Argent: Open
Preview** from the host's command palette.

Alternative (no launch.json):

```sh
code --extensionDevelopmentPath=$(pwd) /tmp
```

To produce a `.vsix`:

```sh
npm run package
```
