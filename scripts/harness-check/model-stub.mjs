/**
 * Where the harnesses send their model requests during a check.
 *
 * startModelStub(): a local stand-in for the OpenAI (chat completions and Responses),
 * Anthropic and Gemini APIs. It saves each request into the current run's folder and
 * answers with a short "ok", so no model takes part. For Codex, the first Responses request
 * of a run is answered with a tool_search call naming every Argent tool, so that the next
 * request carries all of their schemas (Codex loads MCP tools only through tool_search).
 *
 * startRecordingProxy(): forwards to the real Anthropic API, for Claude Code, which needs
 * its signed-in account. It saves the request bodies, never the headers, and next to each
 * one the token usage Anthropic reported for it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import zlib from "node:zlib";

function recorder() {
  let dir = "";
  let count = 0;
  return {
    use(next) {
      dir = next;
      count = 0;
      mkdirSync(dir, { recursive: true });
    },
    save(req, raw) {
      if (!dir) return "";
      let body = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // Not JSON; keep the text.
      }
      const id = String(++count).padStart(3, "0");
      const slug = req.url.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
      const file = join(dir, `${id}-${req.method}${slug}.json`);
      writeFileSync(file, JSON.stringify({ method: req.method, url: req.url, body }, null, 1));
      return file;
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

const MODEL = "harness-check-model";
const REPLY = "ok";

function sse(res, data, event) {
  res.write(
    `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
  );
}

function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function chatCompletions(res, stream) {
  const base = { id: "chatcmpl-1", created: 0, model: MODEL };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!stream) {
    const message = { role: "assistant", content: REPLY };
    const choices = [{ index: 0, message, finish_reason: "stop" }];
    return json(res, { ...base, object: "chat.completion", choices, usage });
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = { ...base, object: "chat.completion.chunk" };
  const delta = { role: "assistant", content: REPLY };
  sse(res, { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] });
  sse(res, { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
  sse(res, "[DONE]");
  res.end();
}

function responses(res, toolSearchQuery) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const usage = {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  };
  const item = toolSearchQuery
    ? {
        type: "tool_search_call",
        call_id: "harness-check-search",
        execution: "client",
        status: "completed",
        arguments: { query: toolSearchQuery, limit: 200 },
      }
    : {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: REPLY, annotations: [] }],
      };
  const response = { id: "resp_1", status: "completed", output: [item], usage };
  sse(
    res,
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    "response.created"
  );
  sse(
    res,
    { type: "response.output_item.done", output_index: 0, item },
    "response.output_item.done"
  );
  sse(res, { type: "response.completed", response }, "response.completed");
  res.end();
}

function anthropicMessages(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const usage = { input_tokens: 1, output_tokens: 0 };
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [],
    stop_reason: null,
    usage,
  };
  sse(res, { type: "message_start", message }, "message_start");
  sse(
    res,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    "content_block_start"
  );
  sse(
    res,
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: REPLY } },
    "content_block_delta"
  );
  sse(res, { type: "content_block_stop", index: 0 }, "content_block_stop");
  sse(
    res,
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    "message_delta"
  );
  sse(res, { type: "message_stop" }, "message_stop");
  res.end();
}

function gemini(res, stream) {
  const reply = {
    candidates: [
      { content: { role: "model", parts: [{ text: REPLY }] }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    modelVersion: MODEL,
  };
  if (!stream) return json(res, reply);
  res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, reply);
  res.end();
}

export async function startModelStub() {
  const rec = recorder();
  let toolSearchQuery = "";
  const server = http.createServer(async (req, res) => {
    const raw = (await readBody(req)).toString("utf8");
    rec.save(req, raw);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      // Answered by URL alone.
    }
    const url = req.url ?? "";
    if (req.method === "GET" && /\/models\/?(\?.*)?$/.test(url)) {
      return json(res, {
        object: "list",
        data: [{ id: MODEL, object: "model", created: 0, owned_by: "harness-check" }],
        models: [{ name: `models/${MODEL}` }],
      });
    }
    if (/chat\/completions/.test(url)) return chatCompletions(res, body.stream === true);
    if (/\/responses/.test(url)) {
      const query = toolSearchQuery;
      toolSearchQuery = "";
      return responses(res, query);
    }
    if (/\/messages\/count_tokens/.test(url)) return json(res, { input_tokens: 1 });
    if (/\/messages/.test(url)) return anthropicMessages(res);
    if (/countTokens/i.test(url)) return json(res, { totalTokens: 1 });
    if (/generateContent/i.test(url)) return gemini(res, /streamGenerateContent/i.test(url));
    json(
      res,
      { error: { message: `harness-check stub: no handler for ${req.method} ${url}` } },
      404
    );
  });
  const url = await listen(server);
  return {
    url,
    /** Save requests into `dir` from now on. `codexToolSearch` arms the tool_search reply. */
    use(dir, codexToolSearch = "") {
      rec.use(dir);
      toolSearchQuery = codexToolSearch;
    },
    close: () => server.close(),
  };
}

/** The usage block of an Anthropic response, streamed (SSE) or not. */
function anthropicUsage(text) {
  /** @type {Record<string, any> | null} */
  let usage = null;
  for (const line of text.split("\n")) {
    const data = line.startsWith("data: ") ? line.slice(6) : line.startsWith("{") ? line : "";
    if (!data) continue;
    try {
      const event = JSON.parse(data);
      if (event.type === "message_start") usage = { ...event.message?.usage };
      else if (event.type === "message_delta" && usage) usage = { ...usage, ...event.usage };
      else if (event.usage && !event.type?.startsWith("content_block")) usage = { ...event.usage };
    } catch {
      // Not a JSON line.
    }
  }
  return usage;
}

function decode(buffer, encoding) {
  try {
    if (encoding === "gzip") return zlib.gunzipSync(buffer).toString("utf8");
    if (encoding === "br") return zlib.brotliDecompressSync(buffer).toString("utf8");
    if (encoding === "deflate") return zlib.inflateSync(buffer).toString("utf8");
  } catch {
    return "";
  }
  return buffer.toString("utf8");
}

export async function startRecordingProxy(host = "api.anthropic.com") {
  const rec = recorder();
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const file = rec.save(req, body.toString("utf8"));
    const headers = { ...req.headers, host, "content-length": String(body.length) };
    const upstream = https.request({ host, path: req.url, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        const usage = anthropicUsage(decode(Buffer.concat(chunks), up.headers["content-encoding"]));
        if (!file || !usage) return;
        const record = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(
          file,
          JSON.stringify({ ...record, response: { status: up.statusCode, usage } }, null, 1)
        );
      });
      up.pipe(res);
    });
    upstream.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    upstream.end(body);
  });
  const url = await listen(server);
  return { url, use: (dir) => rec.use(dir), close: () => server.close() };
}
