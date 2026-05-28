import { app, BrowserWindow } from "electron";
import * as readline from "node:readline";

// One-window-at-a-time host for the variant-selection preview UI. The
// tool-server spawns this process when `await_user_selection` parks, then
// pipes single-line JSON commands ({cmd:"foreground"|"close",url?}) over
// stdin to reuse or dismiss the window across rounds.
//
// The squeeze animation is done by transforming <html> in the renderer
// (CSS scaleY, GPU-composited) — NOT by resizing the OS window. Resizing
// the window forces Chromium to relayout the heavy preview content on
// every frame, which was the lag the previous setBounds-based approach
// surfaced. With a transparent BrowserWindow at full size + a scaleY
// transform on <html>, the only work per frame is a compositor matrix
// multiply, and there's no post-animation residual because the OS window
// never shrinks (it just disappears with app.quit at the end).
const TARGET_WIDTH = 1200;
const TARGET_HEIGHT = 820;
const ANIMATION_MS = 320;

let win: BrowserWindow | null = null;

// Both phases of the squeeze run as CSS transitions inside the renderer.
// The Promise the snippet returns to `executeJavaScript` resolves on
// `transitionend`, so the main process learns when the animation has
// actually finished instead of having to time it.
function squeezeSnippet(toScale: number, durationMs: number): string {
  return `
    new Promise(resolve => {
      const root = document.documentElement;
      const s = root.style;
      s.transformOrigin = '50% 50%';
      s.transition = 'transform ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)';
      // Two rAFs so the previous transform (set just before this snippet)
      // has been committed and rendered before the transition starts.
      // Without this, the browser collapses both writes into one frame
      // and skips the animation.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const onEnd = () => { root.removeEventListener('transitionend', onEnd); resolve(); };
        root.addEventListener('transitionend', onEnd, { once: true });
        // Safety in case transitionend never fires (off-screen tab, e.g.):
        setTimeout(resolve, ${durationMs + 80});
        s.transform = 'scaleY(${toScale})';
      }));
    });
  `;
}

// CSS injected on every load: forces the page canvas transparent so the
// transparent BrowserWindow actually shows OS pixels around the squeezed
// content. Without this, the renderer's `html { background: --color-bg }`
// rule propagates to the document canvas (per CSS Backgrounds L3), which
// paints the entire viewport dark grey even though the renderer itself
// is scaled. The dark surface is moved to #root so the "card" still has
// the right colour where it's actually drawn.
const HOST_CSS = `
  html, body { background: transparent !important; }
  #root { background: var(--color-bg); }
`;

// Pre-show prep: install the host CSS + snap <html> to scaleY(0). Runs
// while the BrowserWindow is still `show: false`, so the very first frame
// the OS composites is "transparent window + collapsed card" with no
// flash of the full-size dark page.
async function prepareSqueeze(): Promise<void> {
  const current = win;
  if (!current) return;
  await current.webContents.executeJavaScript(`
    (() => {
      const style = document.createElement('style');
      style.setAttribute('data-argent-preview-host', '');
      style.textContent = ${JSON.stringify(HOST_CSS)};
      document.head.appendChild(style);
      const s = document.documentElement.style;
      s.transformOrigin = '50% 50%';
      s.transition = 'none';
      s.transform = 'scaleY(0)';
      void document.documentElement.offsetHeight;
    })();
  `);
}

async function squeezeIn(): Promise<void> {
  const current = win;
  if (!current) return;
  await current.webContents.executeJavaScript(squeezeSnippet(1, ANIMATION_MS));
}

async function squeezeOut(): Promise<void> {
  const current = win;
  if (!current) return;
  await current.webContents.executeJavaScript(squeezeSnippet(0, ANIMATION_MS));
}

async function createWindow(): Promise<void> {
  const url = process.env.ARGENT_PREVIEW_URL;
  if (!url) {
    process.stderr.write("[preview-window] ARGENT_PREVIEW_URL not set, exiting\n");
    app.quit();
    return;
  }
  win = new BrowserWindow({
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    frame: false,
    show: false,
    // Transparent + no native shadow: the OS window is just a passthrough
    // for the renderer. The visible "card" is whatever <html> + <body>
    // paints, which is what we squeeze with the CSS transform.
    transparent: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("closed", () => {
    win = null;
    app.quit();
  });
  try {
    await win.loadURL(url);
  } catch (err) {
    process.stderr.write(
      `[preview-window] loadURL failed for ${url}: ${err instanceof Error ? err.message : err}\n`
    );
    app.quit();
    return;
  }
  win.center();
  // Install the host CSS + snap to collapsed BEFORE show — otherwise the
  // first frame is the fully-painted dark page (1 frame of flash).
  await prepareSqueeze();
  win.show();
  void squeezeIn();
}

function foreground(url: string | undefined): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (url && win.webContents.getURL() !== url) {
    win.loadURL(url).catch((err: unknown) => {
      process.stderr.write(
        `[preview-window] foreground loadURL failed: ${err instanceof Error ? err.message : err}\n`
      );
    });
  }
}

async function closeWithAnimation(): Promise<void> {
  if (!win) {
    app.quit();
    return;
  }
  await squeezeOut();
  // The OS window disappears the instant `app.quit` runs — no residual
  // tiny strip lingering after the animation.
  app.quit();
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

// Tool-server drives the lifecycle over stdin — each line is one JSON command.
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: { cmd?: string; url?: string };
  try {
    msg = JSON.parse(line) as { cmd?: string; url?: string };
  } catch {
    return;
  }
  if (msg.cmd === "foreground") foreground(msg.url);
  else if (msg.cmd === "close") void closeWithAnimation();
});
// If the tool-server goes away (stdin closed), exit so we never strand a
// window without a controller.
rl.on("close", () => app.quit());
