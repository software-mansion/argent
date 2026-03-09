# Radon Lite — Project Memory

## Architecture
- **Registry pattern**: `ToolDefinition` objects registered in `packages/tools/src/setup-registry.ts`
- **Service blueprints**: Lazy JIT-instantiated services (e.g. `JsRuntimeDebugger`, `ProfilerSession`)
- **HTTP server**: Tools served via Express at `packages/tools/src/index.ts` (port 3001)
- **MCP proxy**: `packages/mcp/src/index.ts` bridges MCP → HTTP tools server
- **tsconfig**: `"module": "commonjs"` — CJS output, no `"type": "module"` in tools package

## Key Files
- `packages/tools/src/setup-registry.ts` — registers all blueprints and tools
- `packages/tools/src/blueprints/js-runtime-debugger.ts` — CDPClient + Metro connection blueprint
- `packages/tools/src/blueprints/profiler-session.ts` — profiler state blueprint (depends on JsRuntimeDebugger)
- `packages/tools/src/debugger/cdp-client.ts` — CDPClient class (send, evaluate, events)
- `packages/tools/src/tools/debugger/` — debugger tools (debugger-connect, debugger-evaluate, etc.)
- `packages/tools/src/tools/profiler/` — profiler tools (profiler-start, profiler-stop, profiler-analyze, etc.)
- `packages/tools/src/profiler/src/pipeline/` — 5-stage analysis pipeline (kept as-is)
- `.claude/skills/rn-profiler.md` — profiler workflow skill

## Profiler Integration (done)
- ProfilerSession blueprint: `packages/tools/src/blueprints/profiler-session.ts`
  - Depends on `JsRuntimeDebugger`, enables Profiler domain, injects FIBER_ROOT_TRACKER_SCRIPT
  - Detects RN architecture + Hermes version on init
  - Stores `cpuProfile`, `commitTree`, `profilingActive` across tool calls
- 8 profiler tools registered: `profiler-start`, `profiler-stop`, `profiler-analyze`, `profiler-component-source`, `profiler-cpu-summary`, `profiler-react-renders`, `profiler-fiber-tree`, `profiler-console-logs`
- Pipeline files in `profiler/src/pipeline/` — ESM `import.meta.url` replaced with `require` for CJS compat
- `tree-sitter` + `tree-sitter-typescript` added to `packages/tools/package.json`

## Tool Pattern
```typescript
export const myTool: ToolDefinition<z.infer<typeof zodSchema>, ReturnType> = {
  id: "category-action",
  description: "...",
  zodSchema,
  services: (params) => ({ serviceName: `Namespace:${params.port}` }),
  async execute(services, params) { ... }
};
```

## CDPClient API (in JsRuntimeDebuggerApi.cdp)
- `cdp.send(method, params?)` — raw CDP command
- `cdp.evaluate(expression)` — Runtime.evaluate, returns the value (not the wrapper)
- `cdp.events.on('scriptParsed' | 'consoleAPICalled' | 'paused' | 'disconnected', handler)`

## Skills Location
`.claude/skills/` — markdown files loaded as Claude skills
