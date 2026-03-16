# MCP Error Signaling and Agent Feedback Loops — Research Notes

> Research conducted March 2026. Sources: MCP spec `2025-11-25`, GitHub discussions, production engineering posts from Google Cloud and Medium.

---

## The core question

How can an MCP server notify an agent that something went wrong — mid-operation, at completion, or across a session — in a way the agent can act on rather than just observe?

---

## The two official error channels

The MCP spec defines two distinct error paths. The distinction determines whether an agent can self-correct.

### Protocol errors (JSON-RPC level)

Structural failures: wrong method, malformed request, unknown tool name. Returned as a top-level `error` object:

```json
{ "error": { "code": -32602, "message": "Unknown tool: invalid_tool_name" } }
```

The spec explicitly notes that agents are *unlikely* to self-correct from these — they indicate problems with the request structure itself, not with the agent's reasoning or parameters.

### Tool execution errors (`isError: true`)

Business-logic failures returned inside a successful JSON-RPC response:

```json
{
  "content": [{ "type": "text", "text": "Invalid departure date: must be in the future. Current date is 08/08/2025." }],
  "isError": true
}
```

These are explicitly designed for agent self-correction. The `isError: true` flag signals that this is an agent-actionable failure. The spec states: **Clients MUST provide tool execution errors to language models to enable self-correction.** The error text in `content` is what the agent sees and reasons from — it should be diagnostic, not generic.

---

## Mid-execution signaling

Several protocol mechanisms allow a server to communicate status *during* a running tool call, before the final result is returned.

### Progress notifications

The client includes a `progressToken` in the request `_meta`. The server can then emit progress updates at any point during execution:

```json
{
  "method": "notifications/progress",
  "params": {
    "progressToken": "abc123",
    "progress": 50,
    "total": 100,
    "message": "Building source map..."
  }
}
```

Progress values must strictly increase. `total` may be omitted if unknown. As of April 2025, partial results can also be streamed through progress notifications via a `partialResult` field — allowing incremental data delivery while the top-level operation continues.

### Structured logging

Servers can emit syslog-severity log messages to the client at any time by declaring `capabilities.logging`. The client can filter by minimum level via `logging/setLevel`. Eight levels are defined: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`.

```json
{
  "method": "notifications/message",
  "params": {
    "level": "error",
    "logger": "simulator-client",
    "data": { "error": "Connection refused", "host": "127.0.0.1", "port": 8081 }
  }
}
```

This channel is appropriate for "something is degrading" signals that don't terminate the operation — a `warning` for a slow upstream, a `critical` when a hard dependency fails. It also provides a way to distinguish severity without every signal being a tool-level error.

### Elicitation

Introduced mid-2025. Allows a server to pause a running tool and request missing data from the user through the client. Two modes:

- **Form mode** — structured data collection with JSON Schema validation (flat objects only). Used for missing parameters, user preferences, or disambiguation.
- **URL mode** — directs the user to an external URL for sensitive interactions (OAuth flows, API key entry) that must not pass through the LLM context.

The task enters `input_required` status. The agent calls `tasks/result` which blocks until the elicitation resolves. This is the mechanism for "I cannot proceed without this information" — not errors per se, but a formalized mid-operation interruption.

### Tasks (experimental, `2025-11-25`)

The full async state machine for long-running operations. Instead of blocking on a tool call, the server immediately returns a `taskId` with `status: working`. The client polls via `tasks/get` or receives push notifications via `notifications/tasks/status`.

Valid status transitions:

```
working → input_required → working
working → completed | failed | cancelled
input_required → completed | failed | cancelled
```

The `statusMessage` field on any transition can carry a human-readable diagnosis. The `failed` status covers both network-level failures and tool calls where `isError: true` was set. Tasks also propagate `progressToken` for the lifetime of the task, so progress notifications continue to work alongside the state machine.

---

## What happens when a service goes down mid-operation

The spec does not prescribe detection, but the consistent production pattern is: **encode the failure in tool response text, not only in HTTP status codes or exception types.**

The agent receives the tool response content. If that content is a raw `ECONNREFUSED` stack trace, the agent has no basis for action. If it reads:

> `Cannot connect to simulator-server (connection refused at http://127.0.0.1:3002). The server process may have crashed or was never started. Call the simulator-server tool to restart it, then retry.`

...the agent has a diagnosis, a cause, and a next step. This is what `format-error.ts` and `toSimulatorNetworkError` in this codebase already implement for simulator network failures.

The three-category taxonomy that matters most for agent recovery:

| Category | Signal to agent | Example |
|---|---|---|
| **Caller error** — bad input | Fix parameters, retry | `"Invalid UDID format — expected xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"` |
| **Transient error** — network, rate limit, restart | Wait and retry, or call restart tool | `"ECONNREFUSED — simulator-server may be restarting"` |
| **Permanent error** — resource gone, not found | Stop attempting, report to user | `"Simulator UDID 'ABC123' not found on this machine"` |

Without this classification, agents either retry permanent errors pointlessly or give up on transient ones too soon. A Feb 2026 analysis ("I Tried Agent Self-Correction. Tool Errors Made It Worse.") found that **vague errors cause agents to double down on failing approaches** — increasing confidence in the current strategy rather than pivoting, because there is no signal telling them *why* the tool failed.

---

## The "context gap" problem and patterns for actionable errors

Most MCP servers are dumb pipes: they return data or an error string and force the agent to reason about what to do next. Every deduction the agent makes costs tokens and can misfire. The solution is embedding heuristics and directives in the response itself — not changing the MCP protocol envelope, but upgrading the message inside it.

Ten patterns identified in production engineering work (Kumar Srinivasan, Jan 2026):

### Pattern 1 — Agent directive
Eliminate the "now what?" reasoning step. Include `next_actions` and `suggestion` directly in successful responses:
```json
{
  "data": { "sentiment": 0.72 },
  "next_actions": ["get_price_history", "check_whale_activity"],
  "suggestion": "Bullish sentiment detected. Validate with price trends."
}
```

### Pattern 2 — Confidence-gated responses
When a tool produces a low-confidence result, flag it and provide a recovery path rather than returning the result as authoritative:
```json
{
  "result": { "classification": "spam" },
  "confidence": 0.51,
  "confidence_threshold": 0.80,
  "below_threshold_action": "call 'get_additional_context' tool"
}
```

### Pattern 3 — Progressive disclosure
Return a dense summary first; include a `detail_tool` and `detail_params` to fetch specifics only if needed. Avoids blowing the context window on data the agent may not need.

### Pattern 4 — Resource linking (HATEOAS for agents)
Embed related resource URIs and `available_actions` in the response. The agent can traverse the data model without knowing the schema in advance.

### Pattern 5 — Semantic error recovery
Never return a raw stack trace or generic error string. Return a structured object with a typed error code, a retry hint, and a `fallback_tool`:
```json
{
  "success": false,
  "error": {
    "code": "SIMULATOR_UNREACHABLE",
    "message": "Cannot connect to simulator-server",
    "retry_after_ms": 0,
    "recovery_actions": ["restart_simulator_server"],
    "fallback_tool": "start-simulator-server"
  }
}
```

### Pattern 6 — Idempotency confirmation
For state-changing operations, confirm whether the action was newly executed or a duplicate — prevents double-execution when the agent retries after a network failure.

### Pattern 7 — Capability advertisement
A tool can declare its own preconditions and limitations so the agent knows what's required before calling it — not just what it can do, but what must be true for it to succeed.

### Pattern 8 — Context carryover
Return session tokens or state fragments the agent should pass to the next call. Avoids redundant re-fetching in multi-step workflows.

### Pattern 9 — Circuit breaker status
When a dependent service is degraded (not fully down), surface that degradation state explicitly:
```json
{
  "service": "metro-bundler",
  "circuit_state": "HALF_OPEN",
  "failure_rate": 0.45,
  "recommendation": "use_fallback",
  "expected_recovery": "2025-01-15T11:00:00Z"
}
```

### Pattern 10 — Audit trail
For complex or multi-step operations, include the tool chain, data sources, and timestamps used to produce the result. Prevents the LLM from trying to re-derive deterministic computations probabilistically and provides a debugging trace.

---

## Production resilience patterns (Google Cloud MCP Reliability Playbook, Mar 2026)

Beyond what individual tool responses communicate, production deployments require resilience infrastructure around tool calls:

**Circuit breaker** — tracks error rates over a rolling window; when failures exceed a threshold, immediately rejects new calls rather than hitting the upstream. Returns a typed `CircuitOpenError` (not a generic error) so downstream code can distinguish "circuit open" from "API returned 500" and log/route accordingly.

**Exponential backoff with jitter** — `min(baseDelay × 2^attempt, maxDelay) ± jitter%`. Prevents thundering-herd amplification when multiple agents retry simultaneously after a blip. The `retryOn` predicate is critical: skip retrying on 4xx (caller errors, won't succeed on retry), retry on 5xx and network failures.

**Timeout budgets at every layer** — every external call gets a timeout appropriate to the operation, not a single global timeout. Cache lookups: 500ms. Tool calls: 10s. Letting one slow operation hold resources indefinitely leads to connection pool exhaustion and health check failures.

**Graceful degradation** — tool failures should never throw from the agent orchestration layer. They should return an error `ToolMessage` with a user-friendly string the LLM can incorporate: "Flight status is temporarily unavailable. Please try again in a few minutes." Partial results are dramatically better than a crash.

**Stale session detection** — when the MCP server restarts and sessions are invalidated, the client should detect the `"Server not initialized"` error pattern, transparently reconnect, and retry the original call once on the fresh connection.

**Internal error boundary** — typed error classes (`TimeoutError`, `CircuitOpenError`, `RateLimitError`) should never surface as stack traces in tool responses. At the API boundary, every error is translated to a user-friendly message. This is both a security requirement (stack traces leak file paths, library versions, infrastructure details) and a trust requirement.

---

## The emerging session-level feedback loop

A March 2026 GitHub proposal (`modelcontextprotocol/modelcontextprotocol#2369`) addresses a complementary gap: **server maintainers have no visibility into how agents experienced their tools** — not error rates (available from server logs), but qualitative signals like confusion between similarly-named tools, documentation that led the agent to pass wrong parameter formats, or tools called 47 times sequentially because no batch mode exists.

The proposal: an opt-in `feedback/submit` mechanism where the *client LLM* analyzes its own session and reports back at session end. Key properties:

- **Strictly opt-in** with user consent; servers must not degrade service for non-participants
- **Session-level** (not per-call) — captures cross-tool patterns that per-call metrics miss
- **Six structured categories**: usability, reliability, documentation, efficiency, interoperability, `capability_gap` (tools that don't exist yet but were needed)
- **Privacy-tiered** — a trust slider from level 1 (metrics only, reveals nothing about intent) to level 5 (full intent including what the user tried to do but couldn't)
- **`confusedWithExternal: true`** flag — passively detects tool-name collisions across MCP servers, which also functions as an early-warning signal for tool-squatting attacks

A working TypeScript SDK prototype exists (`dkindlund/typescript-sdk`, branch `feat/client-experience-feedback`). The complementary server-side tool is [MCPcat](https://github.com/mcpcat) — open-source agent analytics for MCP servers, covering session replay and confusion detection from the server perspective.

---

## How this maps to the current codebase

### What is already implemented well

`format-error.ts` and `toSimulatorNetworkError` already implement the right instinct: human-readable, action-directed error messages with cause chaining. `ECONNREFUSED`, `ECONNRESET`, `AbortError`, and timeout are each handled with a distinct message that names the failed component and prescribes a next step (e.g. "Call the simulator-server tool to restart it, then retry.").

### Gaps relative to the research

**No typed error codes** — `ECONNREFUSED` and a license failure both return HTTP 500. Adding typed codes (`SIMULATOR_DOWN`, `LICENSE_REQUIRED`, `METRO_TIMEOUT`, etc.) in the response body alongside the prose message would let consuming layers classify errors without text parsing.

**No structured `recovery_actions` / `fallback_tool` in response body** — the recovery hint exists as prose inside the error string, but is not machine-readable. Pattern 5 shows the value of having it as structured JSON the agent can route on directly.

**No progress notifications for long-running tools** — tools like `profiler-start`, `boot-simulator`, and blueprint orchestration run for seconds to tens of seconds with no interim signal. The protocol supports `notifications/progress` for this; it requires the client to include a `progressToken` and the server to emit notifications.

**`capabilities.logging` not declared** — the `notifications/message` log channel is available but requires the server to declare the capability. Surfacing `warning`/`error`/`critical` log events from the simulator client, Metro, or CDP connection would give the agent (and client UI) richer, severity-ranked signals without every anomaly becoming a tool-level error.

**No circuit-breaker state surfacing** — when the simulator-server or Metro is intermittently failing (not fully down), the agent currently receives each individual error in isolation. Surfacing a circuit state (healthy / degraded / down) in the response body would let the agent decide earlier to escalate to a restart rather than retrying a degraded service.
