#!/usr/bin/env bash
# Tool discovery + schema parsing.
#
# The whole harness is schema-driven off the CLI's own introspection so it never
# drifts from the shipped tool set:
#   - `argent tools`               -> the authoritative list of tool names
#   - `argent tools describe <t>`  -> per-flag model (name / type / required / enum)
#
# The `describe` flag lines look like:
#   --udid <value>     string (required)  Target device id ...
#   --x <value>        number (required)  Normalized horizontal ...
#   --button <value>   enum: "home" | "back" | ... (required)  Hardware button ...
#   --scale <value>    number  Scale factor ...
#
# We parse those into a compact model file per tool under $E2E_WORK/tools/<t>.model,
# one line per flag:  <name>\t<kind>\t<required 0|1>\t<enumvals csv>
# kind ∈ string|number|boolean|enum|array|object|unknown

: "${E2E_WORK:?E2E_WORK must be set}"
TOOLS_DIR="$E2E_WORK/tools"
mkdir -p "$TOOLS_DIR"

# List all tool names (cached).
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

# Parse one tool's describe output into a model file; echoes the model path.
parse_tool_model() { # <tool>
  local tool="$1"
  local model="$TOOLS_DIR/$tool.model"
  if [ -s "$model" ]; then printf '%s\n' "$model"; return 0; fi
  argent_cli tools describe "$tool" || true
  # Isolate the "Flags:" section and walk each "--flag" line.
  printf '%s\n' "$CLI_OUT" | awk '
    /^Flags:/ { inflags=1; next }
    inflags && /^[[:space:]]*--/ {
      line=$0
      # flag name
      match(line, /--[a-zA-Z0-9-]+/); name=substr(line, RSTART+2, RLENGTH-2)
      req = (line ~ /\(required\)/) ? 1 : 0
      kind="unknown"; enums=""
      if (line ~ /enum:/) {
        kind="enum"
        # capture the quoted enum members
        s=line
        while (match(s, /"[^"]+"/)) {
          v=substr(s, RSTART+1, RLENGTH-2)
          enums = (enums=="") ? v : enums "," v
          s=substr(s, RSTART+RLENGTH)
        }
      } else if (line ~ /\bnumber\b/) { kind="number" }
      else if (line ~ /\bboolean\b/) { kind="boolean" }
      else if (line ~ /\bstring\b/)  { kind="string" }
      else if (line ~ /\barray\b/ || line ~ /\[\]/) { kind="array" }
      else if (line ~ /\bobject\b/)  { kind="object" }
      printf "%s\t%s\t%s\t%s\n", name, kind, req, enums
    }
    inflags && /^[[:space:]]*\(no parameters\)/ { }
  ' > "$model"
  printf '%s\n' "$model"
}

# Helpers over a parsed model file.
model_required_flags() { awk -F'\t' '$3==1 {print $1}' "$1"; }              # names of required flags
model_flag_kind()      { awk -F'\t' -v n="$2" '$1==n {print $2}' "$1"; }    # kind of flag $2
model_enum_flags()     { awk -F'\t' '$2=="enum" {print $1}' "$1"; }         # names of enum flags
model_enum_values()    { awk -F'\t' -v n="$2" '$1==n {print $4}' "$1"; }    # csv enum values of flag $2
model_number_flags()   { awk -F'\t' '$2=="number" {print $1}' "$1"; }       # names of number flags
model_flag_count()     { wc -l < "$1" | tr -d ' '; }
