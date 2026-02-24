export interface Simulator {
  udid: string
  name: string
  state: string
  runtime: string
  deviceType?: string
}

export interface Session {
  id: string
  udid: string
  state: string
  streamUrl: string
  createdAt: string
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
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${method} ${url} → ${res.status}: ${text}`)
  }
  // 204 No Content
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export function createClient(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, '')

  return {
    listSimulators: () =>
      req<Simulator[]>('GET', `${base}/simulators`),

    listRunningSimulators: () =>
      req<Simulator[]>('GET', `${base}/simulators/running`),

    bootSimulator: (udid: string) =>
      req<void>('POST', `${base}/simulators/${encodeURIComponent(udid)}/boot`),

    createSession: (params: { udid: string; token?: string; replay?: boolean; showTouches?: boolean }) =>
      req<Session>('POST', `${base}/sessions`, params),

    destroySession: (id: string) =>
      req<void>('DELETE', `${base}/sessions/${encodeURIComponent(id)}`),

    updateToken: (id: string, token: string) =>
      req<void>('PUT', `${base}/sessions/${encodeURIComponent(id)}/token`, { token }),

    touch: (id: string, type: TouchType, points: TouchPoint[]) =>
      req<void>('POST', `${base}/sessions/${encodeURIComponent(id)}/input/touch`, { type, points }),

    scroll: (id: string, params: { x: number; y: number; deltaX: number; deltaY: number }) =>
      req<void>('POST', `${base}/sessions/${encodeURIComponent(id)}/input/scroll`, params),

    button: (id: string, direction: ButtonDirection, button: ButtonName) =>
      req<void>('POST', `${base}/sessions/${encodeURIComponent(id)}/input/button`, { direction, button }),

    rotate: (id: string, orientation: Orientation) =>
      req<void>('POST', `${base}/sessions/${encodeURIComponent(id)}/input/rotate`, { orientation }),

    paste: (id: string, text: string) =>
      req<void>('POST', `${base}/sessions/${encodeURIComponent(id)}/input/paste`, { text }),

    screenshot: (id: string, rotation?: string) =>
      req<{ id: string; url: string; filePath: string }>(
        'POST',
        `${base}/sessions/${encodeURIComponent(id)}/screenshot`,
        rotation ? { rotation } : {}
      ),

    eventsUrl: (id: string) =>
      `${base}/sessions/${encodeURIComponent(id)}/events`,

    streamUrl: (session: Session) => session.streamUrl,
  }
}

export type ApiClient = ReturnType<typeof createClient>
