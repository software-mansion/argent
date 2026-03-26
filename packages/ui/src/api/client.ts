export interface Simulator {
  type: string
  udid: string
  name: string
  state: string
  runtime: string
  isAvailable: boolean
}

export interface SimulatorSession {
  udid: string
  streamUrl: string
  apiUrl: string
}

export type RegistryServiceState =
  | 'IDLE'
  | 'STARTING'
  | 'RUNNING'
  | 'TERMINATING'
  | 'ERROR'

export interface RegistrySnapshot {
  services: Record<string, { state: RegistryServiceState; dependents: string[] }>
  namespaces: string[]
  tools: string[]
}

export interface TouchPoint {
  x: number
  y: number
}

export type TouchType = 'Down' | 'Up' | 'Move'
export type ButtonDirection = 'Down' | 'Up'
export type ButtonName =
  | 'home'
  | 'back'
  | 'power'
  | 'volumeUp'
  | 'volumeDown'
  | 'appSwitch'
  | 'actionButton'
export type Orientation =
  | 'Portrait'
  | 'LandscapeLeft'
  | 'LandscapeRight'
  | 'PortraitUpsideDown'

async function req<T>(
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${method} ${url} → ${res.status}: ${text}`)
  }
  if (res.status === 204) return undefined as T
  const json = await res.json()
  // Unwrap tools server { data: ... } wrapper
  if (json && typeof json === 'object' && 'data' in json) return (json as { data: T }).data
  return json as T
}

// ── Metro types ────────────────────────────────────────────────────────────────

export interface MetroConnectionInfo {
  port: number
  projectRoot: string
  deviceName: string
  isNewDebugger: boolean
  connected: boolean
}

export interface MetroStatusInfo extends MetroConnectionInfo {
  loadedScripts: number
  enabledDomains: string[]
}

export interface ComponentEntry {
  id: number
  name: string
  depth: number
  rect: { x: number; y: number; w: number; h: number } | null
  isHost: boolean
  parentIdx: number
}

export interface InspectItem {
  name: string
  source: { file: string; line: number; column: number } | null
  code: string | null
  skipped?: boolean
  skipReason?: string
}

export interface BreakpointResult {
  breakpointId: string
  locations: Array<{ scriptId: string; lineNumber: number; columnNumber: number }>
}

export interface ConsoleLogEntry {
  id: number
  level: string
  args: Array<{ type: string; value?: unknown; description?: string }>
  message: string
  timestamp: number
}

type ConsoleLogListener = (entry: ConsoleLogEntry) => void

export interface ConsoleLogStream {
  on(event: 'log', listener: ConsoleLogListener): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: () => void): void
  off(event: 'log', listener: ConsoleLogListener): void
  off(event: 'error', listener: (err: Error) => void): void
  off(event: 'close', listener: () => void): void
  close(): void
}

function createConsoleLogStream(base: string, port: number): ConsoleLogStream {
  const listeners = new Map<string, Set<Function>>()

  const emit = (event: string, ...args: unknown[]) => {
    listeners.get(event)?.forEach((fn) => fn(...args))
  }

  let ws: WebSocket | null = null

  req<{ url: string }>('POST', `${base}/tools/debugger-console-listen`, { port })
    .then(({ url }) => {
      ws = new WebSocket(url)
      ws.onmessage = (event) => {
        try {
          const entry: ConsoleLogEntry = JSON.parse(event.data as string)
          emit('log', entry)
        } catch { /* skip malformed */ }
      }
      ws.onerror = () => emit('error', new Error('Console log WebSocket error'))
      ws.onclose = () => emit('close')
    })
    .catch((err) => emit('error', err instanceof Error ? err : new Error(String(err))))

  return {
    on(event: string, listener: Function) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
    },
    off(event: string, listener: Function) {
      listeners.get(event)?.delete(listener)
    },
    close() {
      ws?.close()
      listeners.clear()
    },
  } as ConsoleLogStream
}

export function createClient(toolsUrl: string) {
  const base = toolsUrl.replace(/\/$/, '')

  return {
    getRegistrySnapshot: () =>
      req<RegistrySnapshot>('GET', `${base}/registry/snapshot`),

    listSimulators: () =>
      req<{ devices: Simulator[] }>('POST', `${base}/tools/list-devices`, {})
        .then(d => d.devices.filter(s => s.type === 'simulator')),

    listRunningSimulators: () =>
      req<{ devices: Simulator[] }>('POST', `${base}/tools/list-devices`, {})
        .then(d => d.devices.filter(s => s.type === 'simulator' && s.state === 'Booted')),

    bootSimulator: (udid: string) =>
      req<void>('POST', `${base}/tools/boot-simulator`, { udid }),

    startSimulator: (params: { udid: string; token?: string }) =>
      req<SimulatorSession>('POST', `${base}/tools/simulator-server`, params),

    // ── Metro tools ──

    metroConnect: (port = 8081) =>
      req<MetroConnectionInfo>('POST', `${base}/tools/debugger-connect`, { port }),

    metroStatus: (port = 8081) =>
      req<MetroStatusInfo>('POST', `${base}/tools/debugger-status`, { port }),

    metroEvaluate: (expression: string, port = 8081) =>
      req<{ result: unknown }>('POST', `${base}/tools/debugger-evaluate`, { port, expression }),

    metroSetBreakpoint: (file: string, line: number, port = 8081, condition?: string) =>
      req<BreakpointResult>('POST', `${base}/tools/debugger-set-breakpoint`, { port, file, line, condition }),

    metroRemoveBreakpoint: (breakpointId: string, port = 8081) =>
      req<{ removed: boolean }>('POST', `${base}/tools/debugger-remove-breakpoint`, { port, breakpointId }),

    metroPause: (port = 8081) =>
      req<{ paused: boolean }>('POST', `${base}/tools/debugger-pause`, { port }),

    metroResume: (port = 8081) =>
      req<{ resumed: boolean }>('POST', `${base}/tools/debugger-resume`, { port }),

    metroStep: (action: 'stepOver' | 'stepInto' | 'stepOut', port = 8081) =>
      req<{ action: string; sent: boolean }>('POST', `${base}/tools/debugger-step`, { port, action }),

    metroComponentTree: (port = 8081, includeSkipped = false) =>
      req<{ components: ComponentEntry[] } | { error: string } | string>(
        'POST', `${base}/tools/debugger-component-tree`, { port, includeSkipped }
      ),

    metroInspectElement: (x: number, y: number, port = 8081, opts?: { contextLines?: number; includeSkipped?: boolean }) =>
      req<{ x: number; y: number; items: InspectItem[] } | { error: string }>(
        'POST', `${base}/tools/debugger-inspect-element`, {
          port, x, y,
          contextLines: opts?.contextLines ?? 3,
          includeSkipped: opts?.includeSkipped ?? false,
        }
      ),

    metroConsoleLogs: (count: number | 'all' = 'all', port = 8081, sinceId?: number) =>
      req<{ logs: ConsoleLogEntry[]; total: number }>(
        'POST', `${base}/tools/debugger-console-logs`, { port, count, sinceId }
      ),

    metroConsoleStream: (port = 8081): ConsoleLogStream =>
      createConsoleLogStream(base, port),
  }
}

export function createSessionClient(apiUrl: string) {
  const { host } = new URL(apiUrl)
  const ws = new WebSocket(`ws://${host}/ws`)
  let reqId = 0
  const send = (cmd: object) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: String(++reqId), ...cmd }))
    }
  }

  return {
    ws,

    touch: (_id: string, type: TouchType, points: TouchPoint[]): Promise<void> => {
      send({
        cmd: 'touch',
        type,
        x: points[0].x,
        y: points[0].y,
        second_x: points[1]?.x ?? null,
        second_y: points[1]?.y ?? null,
      })
      return Promise.resolve()
    },

    scroll: (_id: string, p: { x: number; y: number; deltaX: number; deltaY: number }): Promise<void> => {
      send({ cmd: 'wheel', x: p.x, y: p.y, dx: p.deltaX, dy: p.deltaY })
      return Promise.resolve()
    },

    button: (_id: string, direction: ButtonDirection, button: ButtonName): Promise<void> => {
      send({ cmd: 'button', direction, button })
      return Promise.resolve()
    },

    rotate: (_id: string, orientation: Orientation): Promise<void> => {
      send({ cmd: 'rotate', direction: orientation })
      return Promise.resolve()
    },

    paste: (_id: string, text: string): Promise<void> => {
      send({ cmd: 'paste', text })
      return Promise.resolve()
    },

    screenshot: (_id: string, rotation?: string): Promise<{ url: string; path: string }> =>
      fetch(`${apiUrl}/api/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rotation ? { rotation } : {}),
      }).then(async r => {
        const body = await r.json()
        if (!r.ok) throw new Error(`${r.status}: ${(body as { error?: string }).error ?? r.statusText}`)
        return body as { url: string; path: string }
      }),

    updateToken: (_id: string, token: string): Promise<void> =>
      fetch(`${apiUrl}/api/token/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }).then(() => undefined),

    destroySession: (_id: string): Promise<void> => {
      ws.close()
      return Promise.resolve()
    },

    close: () => ws.close(),
  }
}

export type ToolsClient = ReturnType<typeof createClient>
export type SessionClient = ReturnType<typeof createSessionClient>
