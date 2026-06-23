#!/bin/bash
# Durable Argent tool-server HTTP helper (bypasses MCP stdio — synchronous, scriptable).
# Discovers the live server from ~/.argent/tool-server.json every call (port floats on
# restart, so never hard-code it). Subcommands: url | list | schema NAME | call NAME 'JSON' | raw PATH
DJSON="${ARGENT_DISCOVERY:-$HOME/.argent/tool-server.json}"
if [ -n "${ARGENT_TOOLS_URL:-}" ]; then
  BASE="$ARGENT_TOOLS_URL"; TOKEN="${ARGENT_TOKEN:-}"
else
  read -r PORT HOST TOKEN < <(python3 -c "import json;d=json.load(open('$DJSON'));print(d['port'],d.get('host','127.0.0.1'),d['token'])") || { echo "cannot read $DJSON" >&2; exit 1; }
  BASE="http://$HOST:$PORT"
fi
AUTH=(); [ -n "${TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $TOKEN")
sub="${1:-}"
case "$sub" in
  url) echo "$BASE" ;;
  list) curl -s "${AUTH[@]}" "$BASE/tools" | python3 -c "import sys,json;[print(t['name']) for t in json.load(sys.stdin)['tools']]" ;;
  schema) curl -s "${AUTH[@]}" "$BASE/tools" | python3 -c "import sys,json;d=json.load(sys.stdin);t=[x for x in d['tools'] if x['name']=='${2:-}'];print(json.dumps(t[0].get('inputSchema',{}),indent=2) if t else 'not found')" ;;
  call)
    tool="${2:-}"
    json="${3:-}"; [ -z "$json" ] && json='{}'
    BF="$(mktemp)"; printf '%s' "$json" > "$BF"
    curl -s -X POST "${AUTH[@]}" -H "Content-Type: application/json" --data-binary "@$BF" "$BASE/tools/$tool"
    rm -f "$BF" ;;
  raw) curl -s "${AUTH[@]}" "$BASE${2:-/}" ;;
  *) echo "usage: argent-call url|list|schema NAME|call NAME 'JSON'|raw PATH" >&2; exit 1 ;;
esac
