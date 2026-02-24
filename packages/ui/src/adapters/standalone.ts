import type { HostAdapter, HostMessage, UIMessage } from './types'

export class StandaloneAdapter implements HostAdapter {
  readonly capabilities = { canChangePanelLocation: false }

  private listeners: Array<(msg: HostMessage) => void> = []

  /** Reads serverUrl from query param or localStorage, then notifies listeners */
  init(): void {
    const params = new URLSearchParams(window.location.search)
    const url =
      params.get('serverUrl') ?? localStorage.getItem('rl-serverUrl') ?? null
    if (url) {
      // Defer so App has time to register its listener
      setTimeout(() => {
        this.listeners.forEach((cb) => cb({ type: 'setServerUrl', url }))
      }, 0)
    }
  }

  onMessage(cb: (msg: HostMessage) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb)
    }
  }

  send(msg: UIMessage): void {
    // In standalone mode the host is a browser — no-op except for logging
    console.debug('[StandaloneAdapter] send', msg)
  }
}
