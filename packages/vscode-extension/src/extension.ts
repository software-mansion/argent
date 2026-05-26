import * as vscode from "vscode";

const COMMAND_OPEN = "argent.openPreview";
const COMMAND_RELOAD = "argent.reloadPreview";
const SETTINGS_NS = "argent";
const SETTING_TOOL_SERVER = "toolServerUrl";
const DEFAULT_TOOL_SERVER = "http://127.0.0.1:3001";
const PANEL_VIEW_TYPE = "argentPreview";
const PANEL_TITLE = "Argent Preview";

let activePanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN, () => openPreview()),
    vscode.commands.registerCommand(COMMAND_RELOAD, () => reloadPreview()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SETTINGS_NS}.${SETTING_TOOL_SERVER}`) && activePanel) {
        reloadPreview();
      }
    })
  );
}

export function deactivate(): void {
  activePanel?.dispose();
  activePanel = undefined;
}

function openPreview(): void {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const toolServerUrl = getToolServerUrl();
  const port = portOf(toolServerUrl);

  const panel = vscode.window.createWebviewPanel(
    PANEL_VIEW_TYPE,
    PANEL_TITLE,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      portMapping: [{ webviewPort: port, extensionHostPort: port }],
    }
  );

  panel.onDidDispose(() => {
    if (activePanel === panel) {
      activePanel = undefined;
    }
  });

  panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
    if (msg?.type === "reload") {
      reloadPreview();
    }
  });

  activePanel = panel;
  panel.webview.html = renderHtml(toolServerUrl);
}

function reloadPreview(): void {
  if (!activePanel) return;
  // portMapping is set at creation time, so a URL/port change needs a fresh
  // panel. Dispose + reopen always — cheap, and avoids divergence between
  // the iframe src and the mapped port.
  activePanel.dispose();
  openPreview();
}

function getToolServerUrl(): string {
  const config = vscode.workspace.getConfiguration(SETTINGS_NS);
  const raw = (config.get<string>(SETTING_TOOL_SERVER) ?? DEFAULT_TOOL_SERVER).trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_TOOL_SERVER;
    return `${u.protocol}//${u.host}`;
  } catch {
    return DEFAULT_TOOL_SERVER;
  }
}

function portOf(url: string): number {
  const u = new URL(url);
  if (u.port) return parseInt(u.port, 10);
  return u.protocol === "https:" ? 443 : 80;
}

function renderHtml(toolServerUrl: string): string {
  // VSCode webviews block iframes pointing at arbitrary http origins; the only
  // escape hatch is `portMapping` + an iframe whose host is literally
  // `localhost`. Canonicalise the iframe / CSP origin to that form even when
  // the user-facing URL is `127.0.0.1:<port>`.
  const u = new URL(toolServerUrl);
  const webviewOrigin = `${u.protocol}//localhost:${portOf(toolServerUrl)}`;
  const previewUrl = `${webviewOrigin}/preview/`;
  const csp = [
    "default-src 'none'",
    `frame-src ${webviewOrigin}`,
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
  ].join("; ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}" />
    <title>${escapeHtml(PANEL_TITLE)}</title>
    <style>
      :root { color-scheme: dark light; }
      html, body { margin: 0; padding: 0; height: 100%; width: 100%; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #ccc); font-family: var(--vscode-font-family); }
      #wrap { position: relative; height: 100vh; width: 100vw; display: flex; flex-direction: column; }
      iframe { flex: 1; width: 100%; border: 0; background: transparent; }
      #toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #333); background: var(--vscode-editorWidget-background, #252526); font-size: 12px; flex-shrink: 0; }
      #toolbar code { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
      #toolbar button { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); border: 0; padding: 3px 9px; border-radius: 3px; cursor: pointer; font-size: 12px; }
      #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
      #toolbar .spacer { flex: 1; }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="toolbar">
        <span>Tool-server:</span>
        <code>${escapeHtml(toolServerUrl)}</code>
        <span class="spacer"></span>
        <button id="reload" type="button">Reload</button>
      </div>
      <iframe
        src="${escapeAttr(previewUrl)}"
        referrerpolicy="no-referrer"
        allow="clipboard-read; clipboard-write"
      ></iframe>
    </div>
    <script>
      (function () {
        const vscode = acquireVsCodeApi();
        document.getElementById("reload").addEventListener("click", function () {
          vscode.postMessage({ type: "reload" });
        });
      })();
    </script>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
