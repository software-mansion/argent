import { useState } from 'react'
import { useAdapter } from '../App'

/**
 * Fullscreen blocker rendered over SessionView when a paywalled feature
 * is attempted without a token. Sends requestToken to the host adapter
 * and enters a waiting state until the host responds with setToken.
 */
export default function TokenRequiredOverlay() {
  const adapter = useAdapter()
  const [waiting, setWaiting] = useState(false)

  function handleProvideToken() {
    setWaiting(true)
    adapter.send({ type: 'requestToken' })
  }

  return (
    <div
      className="
        absolute inset-0
        flex flex-col items-center justify-center gap-4
        bg-rl-bg/90 backdrop-blur-sm
        z-50
      "
    >
      <LockIcon />

      <div className="text-center max-w-xs px-4">
        <p className="text-sm font-semibold text-rl-fg mb-1">Pro feature</p>
        <p className="text-xs text-rl-fg-muted">
          Screenshots, screen recording, and replay require an active Argent
          Pro, Team, or Enterprise subscription.
        </p>
      </div>

      {waiting ? (
        <p className="text-xs text-rl-fg-muted animate-pulse">
          Waiting for token…
        </p>
      ) : (
        <button
          onClick={handleProvideToken}
          className="
            px-4 py-2 rounded text-sm font-medium
            bg-rl-accent text-white
            hover:bg-rl-accent-hover
            transition-colors
          "
        >
          Provide token
        </button>
      )}
    </div>
  )
}

function LockIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="text-rl-fg-muted"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
