import type { HostAdapter, HostMessage, UIMessage } from './types'

// Augment window with VSCode API
declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage(msg: unknown): void
      getState(): unknown
      setState(state: unknown): void
    }
  }
}

export class VsCodeAdapter implements HostAdapter {
  private vscode = window.acquireVsCodeApi!()
  readonly capabilities = { canChangePanelLocation: true }

  constructor() {
    document.body.dataset.platform = 'vscode'
  }

  onMessage(cb: (msg: HostMessage) => void): () => void {
    const handler = (event: MessageEvent) => {
      const msg = event.data as HostMessage
      if (msg && typeof msg.type === 'string') {
        cb(msg)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }

  send(msg: UIMessage): void {
    this.vscode.postMessage(msg)
  }
}
