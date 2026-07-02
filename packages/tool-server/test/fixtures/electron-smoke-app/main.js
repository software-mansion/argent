// Minimal Electron main process for the Chromium E2E smoke test. Opens a single
// window onto index.html and quits when it closes. No services, no IPC, no
// network — the window just has to render so screenshot returns real pixels and
// gesture-tap has something at (0.5, 0.5) to hit.
const { app, BrowserWindow } = require("electron");
const path = require("path");

// Software rendering: CI runners have no usable GPU (and on Linux the window
// lives inside Xvfb). Deterministic, and avoids GPU-process startup flake. The
// Chromium jobs also pass --no-sandbox via electronArgs on Linux; this keeps
// the app launchable by hand on a dev box too.
app.commandLine.appendSwitch("disable-gpu");

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
