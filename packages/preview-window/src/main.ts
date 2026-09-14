import { app, BrowserWindow } from "electron";
import * as readline from "node:readline";

// Feeds app.getName() and the default menu items ("Quit Argent Lens", the
// About panel). Must run before `app` is ready for the default menu to pick
// it up. The bold menu-bar title comes from the bundle's CFBundleName and no
// runtime call overrides it.
app.setName("Argent Lens");

// One-window-at-a-time host for the Argent Lens preview UI. The tool-server
// spawns this process when `await_user_selection` parks, then pipes
// single-line JSON commands ({cmd:"foreground"|"close",url?}) over stdin to
// reuse or dismiss the window across rounds.
//
// The squeeze animation transforms <html> in the renderer (CSS scaleY,
// GPU-composited) rather than resizing the OS window: resizing makes Chromium
// relayout the heavy preview content every frame. The window keeps its full
// size and simply disappears with app.quit, so nothing lingers afterwards.
const TARGET_WIDTH = 1200;
const TARGET_HEIGHT = 820;
const ANIMATION_MS = 320;

let win: BrowserWindow | null = null;

// The Promise the snippet returns to `executeJavaScript` resolves on
// `transitionend`, so the main process learns when the animation actually
// finished instead of having to time it.
function squeezeSnippet(toScale: number, durationMs: number): string {
  // Squeeze-IN must drop the transform once it settles: a lingering
  // `transform: scaleY(1)` on <html> establishes a containing block that breaks
  // Chromium's `-webkit-app-region` hit-testing, so the window stops being
  // draggable by its background. Squeeze-OUT keeps it — clearing would pop the
  // collapsed card back before the quit.
  const clearWhenDone = toScale === 1;
  return `
    new Promise(resolve => {
      const root = document.documentElement;
      const s = root.style;
      s.transformOrigin = '50% 50%';
      s.transition = 'transform ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)';
      const done = () => {
        ${clearWhenDone ? "s.transition = ''; s.transform = '';" : ""}
        resolve();
      };
      // Two rAFs so the previous transform (set just before this snippet)
      // has been committed and rendered before the transition starts.
      // Without this, the browser collapses both writes into one frame
      // and skips the animation.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const onEnd = () => { root.removeEventListener('transitionend', onEnd); done(); };
        root.addEventListener('transitionend', onEnd, { once: true });
        // Safety in case transitionend never fires (off-screen tab, e.g.):
        setTimeout(done, ${durationMs + 80});
        s.transform = 'scaleY(${toScale})';
      }));
    });
  `;
}

// Makes the page canvas transparent so the transparent BrowserWindow shows OS
// pixels around the squeezed content: otherwise the renderer's html/body
// background propagates to the document canvas and paints the whole viewport
// even though the content is scaled. The surface moves to #root, where the
// "card" is actually drawn.
const HOST_CSS = `
  html, body { background: transparent !important; }
  #root { background: var(--color-bg); }
`;

// Log instead of reject: a renderer crash or a webContents destroyed
// mid-animation must not take down the Electron main process.
async function runInRenderer(snippet: string, label: string): Promise<void> {
  const current = win;
  if (!current) return;
  try {
    await current.webContents.executeJavaScript(snippet);
  } catch (err) {
    process.stderr.write(
      `[preview-window] ${label} failed: ${err instanceof Error ? err.message : err}\n`
    );
  }
}

// Install the host CSS + snap <html> to scaleY(0) while the window is still
// `show: false`, so the first frame the OS composites is the collapsed card
// with no flash of the full-size page.
async function prepareSqueeze(): Promise<void> {
  await runInRenderer(
    `
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
  `,
    "prepareSqueeze"
  );
}

async function squeezeIn(): Promise<void> {
  await runInRenderer(squeezeSnippet(1, ANIMATION_MS), "squeezeIn");
}

async function squeezeOut(): Promise<void> {
  await runInRenderer(squeezeSnippet(0, ANIMATION_MS), "squeezeOut");
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
    title: "Argent Lens",
    // Keeps the real macOS traffic lights in the top-left while hiding the rest
    // of the title bar, so the window still reads as frameless. `frame: false`
    // would suppress the buttons entirely.
    titleBarStyle: "hidden",
    // Same 14px inset the in-window corner panels use, so native buttons and
    // handcrafted chrome read as one margin. Keep x and y equal — an asymmetric
    // inset reads as visibly off against the square corner panels.
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    // The OS window is just a passthrough for the renderer: the visible "card"
    // is whatever <html> + <body> paints, and that is what the CSS transform
    // squeezes.
    transparent: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Some macOS/Electron combinations hide the traffic lights when `transparent`
  // is set. Undefined off macOS.
  win.setWindowButtonVisibility?.(true);
  win.setTitle("Argent Lens");
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
  app.quit();
}

app
  .whenReady()
  .then(createWindow)
  .catch((err: unknown) => {
    process.stderr.write(
      `[preview-window] initialization failed: ${err instanceof Error ? err.message : err}\n`
    );
    app.quit();
  });
app.on("window-all-closed", () => app.quit());

// The tool-server drives the lifecycle over stdin — one JSON command per line.
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
// Stdin closed means the tool-server is gone — never strand a window without
// a controller.
rl.on("close", () => app.quit());
