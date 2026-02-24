import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import App from './App'
import { VsCodeAdapter } from './adapters/vscode'
import { StandaloneAdapter } from './adapters/standalone'
import type { HostAdapter } from './adapters/types'

let adapter: HostAdapter

if (typeof window.acquireVsCodeApi !== 'undefined') {
  adapter = new VsCodeAdapter()
} else {
  const sa = new StandaloneAdapter()
  sa.init()
  adapter = sa
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App adapter={adapter} />
  </StrictMode>
)
