#!/usr/bin/env bash
# Phase 2 — Argument-matrix validation (offline, no device).
#
# Per tool, rejection cases generated from its parsed schema:
#   - missing-required : omit every flag                 -> must reject
#   - bad-enum         : junk value for each enum flag   -> must reject (that path)
#   - bad-type         : string for a number flag        -> must reject (that path)
#
# The other required flags get valid-typed dummies, so the single intended
# violation is what trips the rejection.

# Excluded from the generated missing-required case: an empty call to a no-arg
# device / network / state tool would really execute. `stop-all-simulator-servers`
# gets targeted cases below instead.
_VAL_EXCLUDE_MISSING="list-devices stop-all-simulator-servers stop-metro native-devtools-status update-argent"

# Valid dummies for every required flag in a model, then "field=raw-json"
# overrides applied on top. Emits the JSON on stdout.
_build_args() {
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
        if kind in ("number", "integer"):
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
  # With no server every call fails with a transport error, which assert_reject
  # cannot tell from a rejection — the tier would score the same green against a
  # dead server as against a live one. Refuse to run instead.
  if ! ensure_server; then
    fail "$P" harness tool-server "no tool-server: a rejection cannot be told from a transport error"
    return 0
  fi

  local names t model
  names="$(list_tool_names)"

  while read -r t; do
    [ -z "$t" ] && continue
    model="$(parse_tool_model "$t")"
    [ -s "$model" ] || { skip "$P" "$t" schema "no flags to validate"; continue; }

    # run_tool addresses fields through the CLI's whole-payload `--args` escape
    # hatch, and a tool declaring its own `args` property takes that flag as
    # that field's value instead (argent-cli/src/flag-parser.ts) — every case
    # below would be judged on a payload the tool never received.
    if awk -F'\t' '$1=="args"{found=1} END{exit !found}' "$model"; then
      skip "$P" "$t" schema "declares its own 'args' field; not reachable through run_tool's --args payload"
      continue
    fi

    local reqs; reqs="$(model_required_flags "$model")"

    if [ -n "$reqs" ]; then
      local first_req; first_req="$(printf '%s\n' "$reqs" | head -1)"
      # zod 4 reports an omitted enum as invalid_value, not invalid_type.
      local first_code="invalid_type"
      [ "$(model_flag_kind "$model" "$first_req")" = "enum" ] && first_code="invalid_value"
      assert_reject "$P" "$t" missing-required '{}' "$first_req" "$first_code"
    else
      case " $_VAL_EXCLUDE_MISSING " in
        *" $t "*) : ;;
        *) skip "$P" "$t" missing-required "no required flags" ;;
      esac
    fi

    local ef
    for ef in $(model_enum_flags "$model"); do
      local args; args="$(_build_args "$model" "$ef=\"__not_a_valid_enum__\"")"
      assert_reject "$P" "$t" "bad-enum:$ef" "$args" "$ef" "invalid_value"
    done

    # Called empty, stop-all-simulator-servers sweeps the machine, so it is on
    # _VAL_EXCLUDE_MISSING and the generated matrix produces nothing for it:
    # these two cases are the only coverage of its `devices` scope guards.
    if [ "$t" = "stop-all-simulator-servers" ]; then
      # `udids` is the natural slip (siblings spell it `udid`); under a
      # stripping schema that typo would be a silent machine-wide sweep.
      assert_reject "$P" "$t" strict-unknown-key '{"udids":["nope"]}' "udids" "unrecognized_keys"
      # An id owning nothing must not read as a clean machine. One bogus id
      # reaps nothing and touches no device, so this is safe to run here.
      run_tool "$t" '{"devices":["__e2e_no_such_device__"]}'
      if [ "$RT_RC" -eq 0 ] && [ "$(printf '%s' "$RT_JSON" | jq -r '.unmatched[0] // ""')" = "__e2e_no_such_device__" ]; then
        pass "$P" "$t" unmatched "bogus id reported, not silently clean"
      else
        fail "$P" "$t" unmatched "expected unmatched:[__e2e_no_such_device__], got rc=$RT_RC $RT_JSON"
      fi
    fi

    # First required number flag, else any number flag, gets a string.
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
