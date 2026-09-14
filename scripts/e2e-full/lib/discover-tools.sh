#!/usr/bin/env bash
# Tool discovery + schema parsing.
#
# Schema-driven off the CLI's own introspection so the harness never drifts from
# the shipped tool set:
#   - `argent tools`               -> the authoritative list of tool names
#   - `argent tools describe <t>`  -> per-flag model (name / type / required / enum)
#
# `describe` flag lines look like:
#   --udid <value>     string (required)  Target device id ...
#   --button <value>   enum: "home" | "back" | ... (required)  Hardware button ...
#   --scale <value>    number  Scale factor ...
#
# Parsed into $E2E_WORK/tools/<t>.model, one line per flag:
#   <name>\t<kind>\t<required 0|1>\t<enumvals csv>
# kind ∈ string|number|integer|boolean|enum|array|object|unknown
# ("unknown" is an `any`-typed field: no one kind to build a value for, so the
#  bad-type matrix leaves it alone.)

: "${E2E_WORK:?E2E_WORK must be set}"
TOOLS_DIR="$E2E_WORK/tools"
mkdir -p "$TOOLS_DIR"

list_tool_names() {
  local cache="$E2E_WORK/tool-names.txt"
  if [ ! -s "$cache" ]; then
    argent_cli tools || true
    printf '%s\n' "$CLI_OUT" \
      | grep -oE '^  [a-z][a-z0-9-]+' \
      | tr -d ' ' \
      | sort -u > "$cache"
  fi
  cat "$cache"
}

# Parse a tool's describe output into a model file; echoes the model path.
parse_tool_model() {
  local tool="$1"
  local model="$TOOLS_DIR/$tool.model"
  if [ -s "$model" ]; then printf '%s\n' "$model"; return 0; fi
  argent_cli tools describe "$tool" || true
  printf '%s\n' "$CLI_OUT" | awk '
    /^Flags:/ { inflags=1; next }
    inflags && /^[[:space:]]*--/ {
      line=$0
      # The class must include "_": flags are named after their schema keys, and
      # snake_case ones (--device_id, --project_root) would be truncated at the
      # underscore into a key no schema knows.
      match(line, /--[a-zA-Z0-9_-]+/); name=substr(line, RSTART+2, RLENGTH-2)
      # Past the flag: "<placeholder> type (required) description". Read the type
      # from that column, not the whole line: descriptions are prose and contain
      # type words too.
      rest = substr(line, RSTART+RLENGTH)
      sub(/^[[:space:]]*<[^>]*>/, "", rest)   # a boolean flag carries no <value>
      sub(/^[[:space:]]+/, "", rest)
      # "-json" is the CLI's rendering of an object / array-of-object field
      # (--selector-json); the schema key is the name without it.
      sub(/-json$/, "", name)
      req = (line ~ /\(required\)/) ? 1 : 0
      kind="unknown"; enums=""
      if (rest ~ /^enum:/) {
        kind="enum"
        s=rest
        while (match(s, /"[^"]+"/)) {
          v=substr(s, RSTART+1, RLENGTH-2)
          enums = (enums=="") ? v : enums "," v
          s=substr(s, RSTART+RLENGTH)
        }
      }
      else if (rest ~ /^number/)  { kind="number" }
      else if (rest ~ /^integer/) { kind="integer" }
      else if (rest ~ /^boolean/) { kind="boolean" }
      else if (rest ~ /^string/)  { kind="string" }
      else if (rest ~ /^array/)   { kind="array" }
      else if (rest ~ /^object/)  { kind="object" }
      printf "%s\t%s\t%s\t%s\n", name, kind, req, enums
    }
    inflags && /^[[:space:]]*\(no parameters\)/ { }
  ' > "$model"
  printf '%s\n' "$model"
}

# Helpers over a parsed model file.
model_required_flags() { awk -F'\t' '$3==1 {print $1}' "$1"; }
model_flag_kind()      { awk -F'\t' -v n="$2" '$1==n {print $2}' "$1"; }
model_enum_flags()     { awk -F'\t' '$2=="enum" {print $1}' "$1"; }
model_enum_values()    { awk -F'\t' -v n="$2" '$1==n {print $4}' "$1"; }
model_number_flags()   { awk -F'\t' '$2=="number"||$2=="integer" {print $1}' "$1"; }  # bad-type feeds these a string
model_flag_count()     { wc -l < "$1" | tr -d ' '; }
