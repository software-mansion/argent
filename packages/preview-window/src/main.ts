import { app, BrowserWindow } from "electron";
import * as readline from "node:readline";

// One-window-at-a-time host for the variant-selection preview UI. The
// tool-server spawns this process when `await_user_selection` parks, then
// pipes single-line JSON commands ({cmd:"foreground"|"close",url?}) over
// stdin to reuse or dismiss the window across rounds.
//
// Feel constants live at the top so the squeeze animation is tunable from
// one place. Width is fixed; only height animates (iris from the vertical
// midpoint), so the toolbar's horizontal centring never jumps.
const TARGET_WIDTH = 1200;
const TARGET_HEIGHT = 820;
const COLLAPSED_HEIGHT = 1;
const ANIMATION_MS = 280;
const FRAME_MS = 16;
const BG_COLOR = "#0e0e10"; // matches packages/ui/theme.css --color-bg

let win: BrowserWindow | null = null;
// Captured after the first natural placement so subsequent animations
// (re-foreground, close) keep the same visual centre.
let centeredX = 0;
let centeredCY = 0;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function animateHeight(from: number, to: number, onDone?: () => void): void {
  if (!win) {
    onDone?.();
    return;
  }
  const startedAt = Date.now();
  const tick = (): void => {
    const current = win;
    if (!current) {
      onDone?.();
      return;
    }
    const elapsed = Date.now() - startedAt;
    const t = Math.min(1, elapsed / ANIMATION_MS);
    const h = Math.max(1, Math.round(from + (to - from) * easeOutCubic(t)));
    const y = Math.round(centeredCY - h / 2);
    current.setBounds({ x: centeredX, y, width: TARGET_WIDTH, height: h });
    if (t < 1) setTimeout(tick, FRAME_MS);
    else onDone?.();
  };
  tick();
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
    backgroundColor: BG_COLOR,
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
  // Load offscreen, then center+show+collapse so the first paint is at the
  // collapsed height — otherwise the user sees a full-size flash before the
  // squeeze begins. A loadURL failure (tool-server gone, stale port) must
  // exit the process rather than strand an invisible BrowserWindow keeping
  // the Electron event loop alive.
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
  const placed = win.getBounds();
  centeredX = placed.x;
  centeredCY = placed.y + Math.round(placed.height / 2);
  win.setBounds({
    x: centeredX,
    y: centeredCY - Math.round(COLLAPSED_HEIGHT / 2),
    width: TARGET_WIDTH,
    height: COLLAPSED_HEIGHT,
  });
  win.show();
  animateHeight(COLLAPSED_HEIGHT, TARGET_HEIGHT);
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

function closeWithAnimation(): void {
  if (!win) {
    app.quit();
    return;
  }
  const startHeight = win.getBounds().height;
  animateHeight(startHeight, COLLAPSED_HEIGHT, () => app.quit());
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
  else if (msg.cmd === "close") closeWithAnimation();
});
// If the tool-server goes away (stdin closed), exit so we never strand a
// window without a controller.
rl.on("close", () => app.quit());
