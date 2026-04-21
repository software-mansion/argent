#!/usr/bin/env bash
# End-to-end check for skills resync + prune in `argent update`.
# Run from the argent repo root. Auto-detects which scope init actually populated.

set -euo pipefail

WORKDIR="/tmp/argent-e2e"
MCP_DIR="packages/mcp"
GLOBAL_LOCK="$HOME/.agents/.skill-lock.json"
[ -n "${XDG_STATE_HOME:-}" ] && GLOBAL_LOCK="$XDG_STATE_HOME/skills/.skill-lock.json"

echo "▸ Heads up: this globally installs the locally-built @swmansion/argent."
echo "  'npm i -g @swmansion/argent' afterward to restore your normal version."
echo

# 1 — Build + pack
echo "▸ Building and packing packages/mcp..."
(cd "$MCP_DIR" && npm run build >/dev/null && npm pack >/dev/null)
TARBALL="$(ls -t "$MCP_DIR"/swmansion-argent-*.tgz | head -1)"
echo "  packed: $TARBALL"

# 2 — Install globally from tarball
echo "▸ Installing $TARBALL globally..."
npm i -g "$TARBALL" >/dev/null
echo "  installed: $(which argent)"

# 3 — Scratch workspace
echo "▸ Preparing $WORKDIR..."
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

# 4 — Init (let output through so you can see what it picks)
echo "▸ Running 'argent init --yes'..."
argent init --yes

# 5 — Detect where skills actually landed
PROJECT_LOCK="$WORKDIR/skills-lock.json"
if [[ -f "$PROJECT_LOCK" ]]; then
  LOCK="$PROJECT_LOCK"
  SCOPE_FLAG=""
  CANON_DIR="$WORKDIR/.agents/skills"
  echo "▸ Skills tracked in PROJECT scope: $LOCK"
elif [[ -f "$GLOBAL_LOCK" ]]; then
  LOCK="$GLOBAL_LOCK"
  SCOPE_FLAG="-g"
  CANON_DIR="$HOME/.agents/skills"
  echo "▸ Skills tracked in GLOBAL scope: $LOCK"
else
  echo "✗ No skills lock file was created by init. Skills install probably failed —"
  echo "  re-run 'argent init' without --yes to see what's going wrong."
  exit 1
fi

NUM_TRACKED=$(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('$LOCK','utf8')).skills).length)")
echo "  $NUM_TRACKED skills in lock."

# 6 — Inject a fake orphan as if a prior argent version had shipped it
ORPHAN="argent-deprecated-workflow"
echo "▸ Injecting orphan '$ORPHAN' into $LOCK and the canonical store..."
node -e "
  const fs = require('fs');
  const lock = JSON.parse(fs.readFileSync('$LOCK', 'utf8'));
  lock.skills['$ORPHAN'] = { sourceType: 'local', source: '/dev/null', computedHash: 'x' };
  fs.writeFileSync('$LOCK', JSON.stringify(lock, null, 2));
"
mkdir -p "$CANON_DIR/$ORPHAN"
echo "# deprecated" > "$CANON_DIR/$ORPHAN/SKILL.md"

# Per-agent symlink into .claude/skills — create alongside the canonical copy.
# For global scope that's ~/.claude/skills; for project scope it's ./.claude/skills.
CLAUDE_DIR="$WORKDIR/.claude/skills"
[[ "$SCOPE_FLAG" == "-g" ]] && CLAUDE_DIR="$HOME/.claude/skills"
mkdir -p "$CLAUDE_DIR"
ln -sfn "$CANON_DIR/$ORPHAN" "$CLAUDE_DIR/$ORPHAN"

echo "  before prune:"
echo "    lock has orphan?          $(grep -q $ORPHAN $LOCK && echo YES || echo NO)"
echo "    canonical dir exists?     $(test -d $CANON_DIR/$ORPHAN && echo YES || echo NO)"
echo "    .claude symlink exists?   $(test -L $CLAUDE_DIR/$ORPHAN && echo YES || echo NO)"

# 7 — Update (already-on-latest → no install, but refresh+prune runs)
echo
echo "▸ Running 'argent update --yes'..."
argent update --yes

# 8 — Verify
echo
echo "▸ After prune:"
LOCK_HAS=$(grep -q $ORPHAN "$LOCK" 2>/dev/null && echo YES || echo NO)
CANON_HAS=$(test -d "$CANON_DIR/$ORPHAN" && echo YES || echo NO)
LINK_HAS=$(test -L "$CLAUDE_DIR/$ORPHAN" && echo YES || echo NO)
echo "    lock has orphan?          $LOCK_HAS   (expected NO)"
echo "    canonical dir exists?     $CANON_HAS   (expected NO)"
echo "    .claude symlink exists?   $LINK_HAS   (expected NO)"

if [[ "$LOCK_HAS" == "NO" && "$CANON_HAS" == "NO" && "$LINK_HAS" == "NO" ]]; then
  echo
  echo "✓ PASS — prune removed the orphan from all three places."
else
  echo
  echo "✗ FAIL — at least one trace of the orphan survived."
  exit 1
fi
