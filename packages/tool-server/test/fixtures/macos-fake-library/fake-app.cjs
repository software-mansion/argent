// A stand-in for a Mac app with the argent library loaded, for the
// macos-foundation tests. It speaks the library's wire format on the inherited
// descriptor and on the listening socket, and turns away a second client while
// one is connected, as the library does.
// `--mode=<m>` picks a misbehaviour: crash, silent, bad-protocol,
// ignore-terminate, windowless, minimized, panel-only. Its one window appears
// 200 ms after the handshake, as a real app's first window comes after its launch.
//
// Network capture: like the real library, it reports requests as CDP events
// only after a `Control` activateNetworkInspection. `Net.request` sends one
// request, and `--launch-request` sends one 150 ms after the start.
"use strict";
const fs = require("node:fs");
const net = require("node:net");

const mode = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=ok").slice(7);
const startedAt = Date.now();
const network = { active: false, activations: 0 };
const clients = new Set();
let nextRequestId = 1;
const bundleId = process.env.ARGENT_INJECT_BUNDLE_ID;
console.log(`fake app ${bundleId} pid ${process.pid} mode ${mode}`);
if (mode === "crash") {
  console.error("fake app: crashing on purpose");
  process.exit(3);
}
// Keeps the process alive whatever the sockets do.
setInterval(() => {}, 1 << 30);
if (mode === "silent") return;

function serve(socket) {
  socket.on("error", () => {});
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.write(
    JSON.stringify({
      type: "Control",
      payload: {
        bundleId,
        pid: process.pid,
        platform: "macos",
        protocol: mode === "bad-protocol" ? 2 : 1,
        libraryVersion: "fake",
      },
    }) + "\n"
  );
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const msg = JSON.parse(line);
      if (msg.type === "Control") control(msg.payload);
      else handle(socket, msg);
    }
  });
}

function control(payload) {
  if (payload.command !== "activateNetworkInspection") return;
  network.active = true;
  network.activations++;
}

/** One request's events, to the connected client, as the real library sends them. */
function sendRequest(url, method) {
  if (!network.active) return;
  const requestId = `fake-${nextRequestId++}`;
  const events = [
    ["Network.requestWillBeSent", { requestId, request: { url, method, headers: {} } }],
    ["Network.responseReceived", { requestId, response: { url, status: 200 } }],
    ["Network.loadingFinished", { requestId, encodedDataLength: 12 }],
  ];
  for (const socket of clients) {
    for (const [name, params] of events) {
      socket.write(JSON.stringify({ type: "CDP", payload: { method: name, params } }) + "\n");
    }
  }
}

if (process.argv.includes("--launch-request")) {
  setTimeout(() => sendRequest("https://example.com/launch", "GET"), 150);
}

function handle(socket, msg) {
  const { id, method, params, deadline } = msg.payload;
  const reply = (body) =>
    socket.write(JSON.stringify({ type: "ViewInspector", payload: { id, ...body } }) + "\n");
  switch (method) {
    case "Echo":
      return reply({ result: { params, pid: process.pid, argv: process.argv.slice(2), deadline } });
    case "Net.request":
      for (let i = 0; i < (params.count ?? 1); i++) sendRequest(params.url, params.method);
      // A CDP reply: its id must neither answer the call nor enter the log.
      socket.write(JSON.stringify({ type: "CDP", payload: { id, result: {} } }) + "\n");
      return reply({ result: { network } });
    case "Net.drop":
      // The fake answers, then closes this client's connection.
      reply({ result: {} });
      return setTimeout(() => socket.destroy(), 20);
    case "Fail":
      return reply({ error: { message: params.message ?? "boom from the library" } });
    case "Hang":
      return;
    case "Window.list":
      return reply({ result: { windows: windows() } });
    case "Application.terminate":
      reply({ result: { terminating: true } });
      if (mode !== "ignore-terminate") setTimeout(() => process.exit(0), 50);
      return;
    default:
      return reply({ error: { message: `Unsupported method: ${method}` } });
  }
}

function windows() {
  if (mode === "windowless" || Date.now() - startedAt < 200) return [];
  const panel = mode === "panel-only";
  return [
    {
      number: 1,
      kind: panel ? "panel" : "window",
      isVisible: true,
      isMiniaturized: mode === "minimized",
      isReference: !panel,
    },
  ];
}

/**
 * One client at a time: the fake tells a second client on the listening socket
 * that the app is busy while the first one is connected. After the first one
 * closes, the fake lets the next one in, so a tool-server that reconnects right
 * after it closes is not refused.
 */
function serveListening(socket) {
  socket.on("error", () => {});
  const live = () => [...clients].some((c) => !c.destroyed && !c.readableEnded);
  if (!live()) return serve(socket);
  setTimeout(() => {
    if (!live()) return serve(socket);
    socket.end(
      JSON.stringify({
        type: "Control",
        payload: { busy: true, bundleId, pid: process.pid, platform: "macos", protocol: 1 },
      }) + "\n"
    );
  }, 30);
}

serve(
  new net.Socket({ fd: Number(process.env.NATIVE_DEVTOOLS_FD), readable: true, writable: true })
);
const listenPath = process.env.NATIVE_DEVTOOLS_LISTEN_SOCKET;
if (listenPath) {
  fs.rmSync(listenPath, { force: true });
  net.createServer(serveListening).listen(listenPath);
}
