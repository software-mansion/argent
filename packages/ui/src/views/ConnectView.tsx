import { useState, FormEvent } from 'react'

interface ConnectViewProps {
  onConnect: (url: string) => void
}

export default function ConnectView({ onConnect }: ConnectViewProps) {
  const saved = localStorage.getItem('rl-serverUrl') ?? 'http://localhost:3000'
  const [url, setUrl] = useState(saved)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = url.trim()
    if (trimmed) onConnect(trimmed)
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 p-8 gap-6">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-rl-fg mb-1">Radon Lite</h1>
        <p className="text-sm text-rl-fg-muted">Enter the address of your radon-lite server</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 w-full max-w-sm">
        <div className="flex flex-col gap-1">
          <label htmlFor="server-url" className="text-xs font-medium text-rl-fg-muted uppercase tracking-wide">
            Server URL
          </label>
          <input
            id="server-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3000"
            className="
              px-3 py-2 rounded border
              bg-rl-surface border-rl-border text-rl-fg
              placeholder:text-rl-fg-muted
              focus:outline-none focus:border-rl-accent
              text-sm
            "
            required
            autoFocus
          />
        </div>

        <button
          type="submit"
          className="
            px-4 py-2 rounded text-sm font-medium
            bg-rl-accent text-white
            hover:bg-rl-accent-hover
            transition-colors
          "
        >
          Connect
        </button>
      </form>
    </div>
  )
}
