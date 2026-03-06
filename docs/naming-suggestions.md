# Naming suggestions — reducing confusion

Suggestions for renaming terms that cause confusion (see `docs/dictionary.md`). Applying these would make the codebase and docs easier to navigate.

---

## 1. "Registry" overload (Registry vs tool registry vs simulator-registry)

**Issue:** The word "registry" is used for three different things:

- **Registry** — the core object (blueprints, services, tools).
- **"Tool registry"** — colloquial for "the tools stored in that same Registry."
- **simulator-registry** — a separate module: a map of simulator-server **processes/connections**, not services in the core Registry.

**Suggestion:** Rename **simulator-registry** to something that doesn't use "registry", e.g.:

- **simulator-process-map** or **simulator-process-cache**
- **simulator-connection-tracker** or **simulator-server-tracker**

Then "registry" means one thing (the core Registry), and "tool registry" is just the tool-registration aspect of it.

---

## 2. Two different "servers": Tools server vs simulator-server

**Issue:** Both are "servers", but one is the Node API (orchestrator), the other is the per-simulator native binary (device I/O). Easy to mix up in conversation and docs.

**Suggestions:**

- Rename **simulator-server** (the binary) to something like **simulator-daemon**, **simulator-agent**, or **simulator-binary** so "server" is reserved for the HTTP tools server; or
- Rename **Tools server** to **Tools API** or **Radon API** so "server" is reserved for the per-simulator process.

Pick one convention and stick to it so "server" always means the same thing.

---

## 3. simulator-api sounds like "the API of the simulator"

**Issue:** **simulator-api** is the **client** that talks to a running simulator-server (sendCommand, httpDescribe, httpScreenshot). The name reads like "the simulator's API surface," not "client that calls the simulator."

**Suggestion:** Rename to **simulator-client** or **simulator-server-client** so it's clear it's the caller side, not the API definition.

---

## 4. "Client" vs "session client" in the UI

**Issue:** "Client" is used for "talks to tools server"; "session client" for "talks to one simulator-server." "Client" alone is ambiguous.

**Suggestion:** Use explicit names in the dictionary (and in code/docs):

- **Tools client** (or **tools-server-client**) for the tools server API.
- **Session client** (or **simulator-session-client**) for a single simulator-server session.

That makes the comparison table and prose unambiguous.

---

## 5. activation-tui

**Issue:** "Activation" could mean many things; the doc clarifies it's for license/SSO activation. The name doesn't say "license" or "terminal."

**Suggestion:** **license-activation-tui** or **activate-license-tui** so it's obvious it's the terminal UI for license activation.

---

## 6. JsRuntimeDebugger

**Issue:** "JsRuntime" is generic; in this codebase it's specifically Metro + CDP. People might think it's "any JS runtime."

**Suggestion:** If you want the name to reflect that, **MetroDebugger** or **MetroCDPBlueprint** (or keep **JsRuntimeDebugger** and add a one-line note in the dictionary: "Metro dev server via CDP").

---

## Summary table

| Current name       | Confusion                              | Possible rename(s)                                   |
| ------------------ | -------------------------------------- | ---------------------------------------------------- |
| simulator-registry | Same word as core Registry             | simulator-process-cache, simulator-server-tracker    |
| simulator-server   | "Server" vs Tools server               | simulator-daemon, simulator-agent                    |
| simulator-api      | Sounds like "simulator's API"          | simulator-client, simulator-server-client            |
| "client" (UI)      | Which server it talks to               | tools-client, tools-server-client                    |
| activation-tui     | What is being activated                | license-activation-tui                               |
| JsRuntimeDebugger  | Suggests any JS runtime                | MetroDebugger (or add "Metro/CDP" in docs)           |

The highest-impact renames are: **simulator-registry** (different concept from Registry), **simulator-server** vs **Tools server** (two "servers"), and **simulator-api** (client vs API).
