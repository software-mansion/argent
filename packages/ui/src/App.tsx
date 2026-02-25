import { useReducer, useEffect, createContext, useContext } from 'react'
import type { HostAdapter, HostMessage } from './adapters/types'
import { createClient } from './api/client'
import type { ToolsClient } from './api/client'
import ConnectView from './views/ConnectView'
import DevicePickerView from './views/DevicePickerView'
import SessionView from './views/SessionView'

// ── Adapter context ────────────────────────────────────────────────────────────

const AdapterContext = createContext<HostAdapter | null>(null)
export function useAdapter(): HostAdapter {
  const a = useContext(AdapterContext)
  if (!a) throw new Error('useAdapter must be used inside AdapterProvider')
  return a
}

// ── API client context ─────────────────────────────────────────────────────────

const ApiContext = createContext<ToolsClient | null>(null)
export function useApi(): ToolsClient {
  const a = useContext(ApiContext)
  if (!a) throw new Error('useApi must be used inside App with a serverUrl')
  return a
}

// ── State machine ──────────────────────────────────────────────────────────────

type AppState =
  | { view: 'waiting-for-url' }
  | { view: 'picking-device'; serverUrl: string }
  | { view: 'session-starting'; serverUrl: string }
  | { view: 'session-active'; serverUrl: string; sessionId: string; streamUrl: string; apiUrl: string; token?: string }
  | { view: 'token-needed'; serverUrl: string; sessionId: string; streamUrl: string; apiUrl: string }

type AppAction =
  | { type: 'SET_SERVER_URL'; url: string }
  | { type: 'SESSION_CREATED'; sessionId: string; streamUrl: string; apiUrl: string }
  | { type: 'SESSION_STARTING' }
  | { type: 'TOKEN_NEEDED' }
  | { type: 'SET_TOKEN'; token: string }
  | { type: 'SESSION_ENDED' }

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_SERVER_URL':
      return { view: 'picking-device', serverUrl: action.url }

    case 'SESSION_STARTING':
      if (state.view !== 'picking-device') return state
      return { view: 'session-starting', serverUrl: state.serverUrl }

    case 'SESSION_CREATED':
      if (state.view !== 'session-starting' && state.view !== 'picking-device') return state
      return {
        view: 'session-active',
        serverUrl: (state as { serverUrl: string }).serverUrl,
        sessionId: action.sessionId,
        streamUrl: action.streamUrl,
        apiUrl: action.apiUrl,
      }

    case 'TOKEN_NEEDED':
      if (state.view !== 'session-active') return state
      return {
        view: 'token-needed',
        serverUrl: state.serverUrl,
        sessionId: state.sessionId,
        streamUrl: state.streamUrl,
        apiUrl: state.apiUrl,
      }

    case 'SET_TOKEN':
      if (state.view !== 'token-needed' && state.view !== 'session-active') return state
      return {
        view: 'session-active',
        serverUrl: (state as { serverUrl: string }).serverUrl,
        sessionId: (state as { sessionId: string }).sessionId,
        streamUrl: (state as { streamUrl: string }).streamUrl,
        apiUrl: (state as { apiUrl: string }).apiUrl,
        token: action.token,
      }

    case 'SESSION_ENDED':
      if (state.view === 'waiting-for-url') return state
      return { view: 'picking-device', serverUrl: (state as { serverUrl: string }).serverUrl }

    default:
      return state
  }
}

// ── App ────────────────────────────────────────────────────────────────────────

interface AppProps {
  adapter: HostAdapter
}

export default function App({ adapter }: AppProps) {
  const [state, dispatch] = useReducer(reducer, { view: 'waiting-for-url' })

  // Listen for host messages
  useEffect(() => {
    const unsub = adapter.onMessage((msg: HostMessage) => {
      if (msg.type === 'setServerUrl') {
        dispatch({ type: 'SET_SERVER_URL', url: msg.url })
      } else if (msg.type === 'setToken') {
        dispatch({ type: 'SET_TOKEN', token: msg.token })
      }
    })
    // Signal host that UI is ready
    adapter.send({ type: 'ready' })
    return unsub
  }, [adapter])

  const serverUrl = 'serverUrl' in state ? state.serverUrl : ''
  const api = serverUrl ? createClient(serverUrl) : null

  function handleConnect(url: string) {
    localStorage.setItem('rl-serverUrl', url)
    dispatch({ type: 'SET_SERVER_URL', url })
  }

  function handleSessionStart() {
    dispatch({ type: 'SESSION_STARTING' })
  }

  function handleSessionCreated(sessionId: string, streamUrl: string, apiUrl: string) {
    dispatch({ type: 'SESSION_CREATED', sessionId, streamUrl, apiUrl })
    adapter.send({ type: 'sessionCreated', sessionId })
  }

  function handleSessionEnded() {
    dispatch({ type: 'SESSION_ENDED' })
  }

  function handleTokenNeeded() {
    dispatch({ type: 'TOKEN_NEEDED' })
    adapter.send({ type: 'requestToken' })
  }

  return (
    <AdapterContext.Provider value={adapter}>
      <ApiContext.Provider value={api}>
        {state.view === 'waiting-for-url' && (
          <ConnectView onConnect={handleConnect} />
        )}

        {(state.view === 'picking-device' || state.view === 'session-starting') && api && (
          <DevicePickerView
            api={api}
            loading={state.view === 'session-starting'}
            onStarting={handleSessionStart}
            onSessionCreated={handleSessionCreated}
          />
        )}

        {(state.view === 'session-active' || state.view === 'token-needed') && (
          <SessionView
            sessionId={state.sessionId}
            streamUrl={state.streamUrl}
            apiUrl={state.apiUrl}
            serverUrl={state.serverUrl}
            token={'token' in state ? state.token : undefined}
            tokenNeeded={state.view === 'token-needed'}
            onSessionEnded={handleSessionEnded}
            onTokenNeeded={handleTokenNeeded}
          />
        )}
      </ApiContext.Provider>
    </AdapterContext.Provider>
  )
}
