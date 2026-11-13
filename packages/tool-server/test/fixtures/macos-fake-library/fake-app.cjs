// A stand-in for a Mac app with the argent library loaded, for the
// macos-foundation tests. It speaks the library's wire format on the inherited
// descriptor and on the listening socket.
// `--mode=<m>` picks a misbehaviour: crash, silent, bad-protocol,
// ignore-terminate, ask-save (answers quit with an alert; asked to quit again
// while it shows it, it quits without saving, as AppKit does; `Prompt.cancel`
// answers it), windowless, minimized, panel-only, network-silent (answers no
// CDP request). `--alert` shows an alert of
// the app's own from the start. `--handshake-delay=<ms>` sends the handshake
// that much later, as a slow launch does. Its one window appears
// 200 ms after the handshake, as a real app's first window comes after its launch.
//
// Network capture: like the real library, it reports requests as CDP events
// only after a CDP Network.enable, which it answers, until Network.disable or
// until the client's connection closes. `Net.request` sends one request (with
// `headers`, a request body `postData`, a response `body`, and `hold: true` to
// send only its first event, until `Net.finish`), and `--launch-request` sends
// one 150 ms after the start. It keeps the bodies and answers the body reads,
// as the real library does.
"use strict";
const fs = require("node:fs");
const net = require("node:net");

const mode = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=ok").slice(7);
const handshakeDelayMs = Number(
  (process.argv.find((a) => a.startsWith("--handshake-delay=")) ?? "=0").split("=")[1]
);
const startedAt = Date.now();
const network = { active: false, activations: 0 };
/** Requests whose last events wait for `Net.finish`. */
const held = [];
/** The bodies of each request, by its requestId. */
const bodies = new Map();
const clients = new Set();
let nextRequestId = 1;
let askingToSave = false;
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
  socket.on("close", () => {
    clients.delete(socket);
    // The real library turns capture off when its client goes.
    network.active = false;
  });
  const hello = () =>
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
  if (handshakeDelayMs > 0) setTimeout(hello, handshakeDelayMs);
  else hello();
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const msg = JSON.parse(line);
      if (msg.type === "CDP") cdp(socket, msg.payload);
      else if (msg.type === "ViewInspector") handle(socket, msg);
    }
  });
}

function cdp(socket, { id, method, params }) {
  if (mode === "network-silent") return;
  const answer = (body) =>
    socket.write(JSON.stringify({ type: "CDP", payload: { id, ...body } }) + "\n");
  switch (method) {
    case "Network.enable":
      network.active = true;
      network.activations++;
      return answer({ result: {} });
    case "Network.disable":
      network.active = false;
      return answer({ result: {} });
    case "Network.getResponseBody": {
      const body = bodies.get(params?.requestId)?.body;
      return body
        ? answer({ result: { body, base64Encoded: false, wasTruncated: false } })
        : answer({ error: { message: "No response body stored for requestId" } });
    }
    case "Network.getRequestPostData": {
      const entry = bodies.get(params?.requestId);
      if (!entry) return answer({ error: { message: "No request stored for requestId" } });
      return entry.postData
        ? answer({ result: { postData: entry.postData, base64Encoded: false } })
        : answer({ error: { message: "No request post data available for requestId" } });
    }
    default:
      return answer({ error: { message: `Unsupported method: ${method}` } });
  }
}

function sendEvents(events) {
  for (const socket of clients) {
    for (const [name, params] of events) {
      socket.write(JSON.stringify({ type: "CDP", payload: { method: name, params } }) + "\n");
    }
  }
}

/** One request's events, to the connected client, as the real library sends them. */
function sendRequest(url, method, headers = {}, hold = false, postData, body) {
  if (!network.active) return;
  const requestId = `fake-${nextRequestId++}`;
  bodies.set(requestId, { postData, body });
  const last = [
    [
      "Network.responseReceived",
      {
        requestId,
        response: { url, status: 200, headers: { "Set-Cookie": "session=fake-secret" } },
      },
    ],
    ["Network.loadingFinished", { requestId, encodedDataLength: body?.length ?? 12 }],
  ];
  // A body the app streams comes with no postData: the agent reads it.
  const request = { url, method, headers, ...(postData ? { hasPostData: true } : {}) };
  sendEvents([["Network.requestWillBeSent", { requestId, request }]]);
  if (hold) held.push(last);
  else sendEvents(last);
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
      for (let i = 0; i < (params.count ?? 1); i++) {
        sendRequest(
          params.url,
          params.method,
          params.headers,
          params.hold === true,
          params.postData,
          params.body
        );
      }
      // A CDP reply: its id must neither answer the call nor enter the log.
      socket.write(JSON.stringify({ type: "CDP", payload: { id, result: {} } }) + "\n");
      return reply({ result: { network } });
    case "Net.finish":
      // The held requests end, to whichever client is connected now.
      if (network.active) for (const events of held.splice(0)) sendEvents(events);
      return reply({ result: {} });
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
      if (mode === "ask-save" && !askingToSave) askingToSave = true;
      else if (mode !== "ignore-terminate") setTimeout(() => process.exit(0), 50);
      return;
    case "Prompt.cancel":
      askingToSave = false;
      return reply({ result: {} });
    default:
      return reply({ error: { message: `Unsupported method: ${method}` } });
  }
}

function windows() {
  if (mode === "windowless" || Date.now() - startedAt < 200) return [];
  const panel = mode === "panel-only";
  const alert = { number: 2, kind: "alert", isVisible: true, isMiniaturized: false };
  const ownAlert = { ...alert, number: 3 };
  return [
    {
      number: 1,
      kind: panel ? "panel" : "window",
      isVisible: true,
      isMiniaturized: mode === "minimized",
      isReference: !panel,
    },
    ...(askingToSave ? [alert] : []),
    ...(process.argv.includes("--alert") ? [ownAlert] : []),
  ];
}

/** A new client on the listening socket replaces the current one, as the library does. */
function serveListening(socket) {
  for (const client of clients) client.destroy();
  serve(socket);
}

serve(
  new net.Socket({ fd: Number(process.env.NATIVE_DEVTOOLS_FD), readable: true, writable: true })
);
const listenPath = process.env.NATIVE_DEVTOOLS_LISTEN_SOCKET;
if (listenPath) {
  fs.rmSync(listenPath, { force: true });
  net.createServer(serveListening).listen(listenPath);
}
