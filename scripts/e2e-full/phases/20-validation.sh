#!/usr/bin/env bash
# Phase 2 — Argument-matrix validation (offline, no device).
#
# For EVERY tool, generates rejection cases straight from its parsed schema:
#   - missing-required : omit all required flags            -> must reject
#   - bad-enum         : junk value for each enum flag      -> must reject (that path)
#   - bad-type         : string where a number is required  -> must reject (that path)
#
# Valid-typed dummies are filled for the *other* required flags so the single
# intended violation is what trips the rejection. This is deterministic and
# needs no hardware — it's the "every combination of arguments" guarantee at the
# validation layer. Runs against the private tool-server started in phase 1.

# Tools with no required flags that would actually EXECUTE (touch a device /
# network / state) if called empty — excluded from missing-required here and
# covered by the device tiers instead.
_VAL_EXCLUDE_MISSING="list-devices stop-all-simulator-servers stop-metro native-devtools-status update-argent"

# Build a JSON object with valid dummies for every required flag in a model,
# then apply overrides "field=raw-json" pairs. Emits the JSON on stdout.
_build_args() { # model [field:rawjson ...]
  local model="$1"; shift
  python3 - "$model" "$@" <<'PY'
import json, sys
model = sys.argv[1]
overrides = {}
for a in sys.argv[2:]:
    k, v = a.split("=", 1)
    overrides[k] = json.loads(v)
obj = {}
with open(model) as fh:
    for line in fh:
        line = line.rstrip("\n")
        if not line:
            continue
        name, kind, req, enums = (line.split("\t") + ["", "", "", ""])[:4]
        if req != "1":
            continue
        if kind == "number":
            obj[name] = 1
        elif kind == "boolean":
            obj[name] = True
        elif kind == "enum":
            obj[name] = (enums.split(",")[0] if enums else "x")
        elif kind == "array":
            obj[name] = []
        elif kind == "object":
            obj[name] = {}
        else:
            obj[name] = "x"
obj.update(overrides)
print(json.dumps(obj))
PY
}

run_phase() {
  local P=validation
  ensure_server || warn "no private server; validation still runs (client-side schema)"

  local names t model
  names="$(list_tool_names)"

  while read -r t; do
    [ -z "$t" ] && continue
    model="$(parse_tool_model "$t")"
    [ -s "$model" ] || { skip "$P" "$t" schema "no flags to validate"; continue; }

    local reqs; reqs="$(model_required_flags "$model")"

    # --- missing-required ---------------------------------------------------
    if [ -n "$reqs" ]; then
      local first_req; first_req="$(printf '%s\n' "$reqs" | head -1)"
      # omit everything -> the first required flag must be flagged undefined
      assert_reject "$P" "$t" missing-required '{}' "$first_req" "invalid_type"
    else
      case " $_VAL_EXCLUDE_MISSING " in
        *" $t "*) : ;;  # device/stateful no-arg tool: covered elsewhere
        *) skip "$P" "$t" missing-required "no required flags" ;;
      esac
    fi

    # --- bad-enum (one case per enum flag) ---------------------------------
    local ef
    for ef in $(model_enum_flags "$model"); do
      local args; args="$(_build_args "$model" "$ef=\"__not_a_valid_enum__\"")"
      assert_reject "$P" "$t" "bad-enum:$ef" "$args" "$ef" "invalid_value"
    done

    # --- bad-type (first required number flag gets a string) ---------------
    local nf
    nf="$(model_number_flags "$model" | while read -r f; do
            awk -F'\t' -v n="$f" '$1==n && $3==1{print n}' "$model"; done | head -1)"
    if [ -z "$nf" ]; then nf="$(model_number_flags "$model" | head -1)"; fi
    if [ -n "$nf" ]; then
      local targs; targs="$(_build_args "$model" "$nf=\"not_a_number\"")"
      assert_reject "$P" "$t" "bad-type:$nf" "$targs" "$nf" "invalid_type"
    fi
  done <<< "$names"
}
