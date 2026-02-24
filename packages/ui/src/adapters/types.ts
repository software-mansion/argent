// Host → UI
export type HostMessage =
  | { type: 'setServerUrl'; url: string }
  | { type: 'setToken'; token: string }

// UI → Host
export type UIMessage =
  | { type: 'ready' }
  | { type: 'requestToken' }
  | { type: 'setPanelLocation'; location: 'left' | 'right' | 'bottom' }
  | { type: 'sessionCreated'; sessionId: string }

export interface HostAdapter {
  /** Register callback for incoming host messages. Returns unsubscribe fn. */
  onMessage(cb: (msg: HostMessage) => void): () => void
  /** Send a message to the host */
  send(msg: UIMessage): void
  capabilities: {
    canChangePanelLocation: boolean
  }
}
