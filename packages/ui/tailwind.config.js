/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'rl-bg': 'var(--rl-bg)',
        'rl-surface': 'var(--rl-surface)',
        'rl-border': 'var(--rl-border)',
        'rl-fg': 'var(--rl-fg)',
        'rl-fg-muted': 'var(--rl-fg-muted)',
        'rl-accent': 'var(--rl-accent)',
        'rl-accent-hover': 'var(--rl-accent-hover)',
        'rl-danger': 'var(--rl-danger)',
      },
    },
  },
  plugins: [],
}
