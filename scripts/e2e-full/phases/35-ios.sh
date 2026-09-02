#!/usr/bin/env bash
# Phase 3.5 — iOS simulator keyboard tier (macOS only).
#
# The iOS clear is a 200-pair HID burst over the simulator-server's stdin pipe,
# and every other tier pins it against an in-memory recorder array: nothing
# anywhere else sends a real HID delete to a real simulator, so an injection
# that stopped landing — a keycode change, a transport regression — would be
# green everywhere. This tier types a known value into a real field and reads it
# back, which is the only check that can go red for that.
#
# Deliberately narrow: keyboard only. It is not an iOS equivalent of the Android
# tier.
#
# The fixture is Settings' own search field, so nothing has to be installed. It
# is a UIKit `UISearchBar`, whose `describe` node carries the typed value as
# `value="…"` — which is what makes "the field emptied" observable from outside
# the tool.
#
# Env overrides:
#   E2E_IOS_UDID   the simulator to drive. REQUIRED — the tier skips without it,
#                  and boots the named device when it is not already running.
#
# Deliberately NOT "whatever happens to be booted". A developer machine runs
# several agent sessions at once, so the first booted simulator in `list-devices`
# is somebody else's device — and this tier launches Settings on it, types, and
# presses Home. Mirrors the android tier, which takes E2E_ANDROID_SERIAL or boots
# E2E_ANDROID_AVD and never picks a device for you.

# The search field's tap point, from `describe`. Returns "x y" in the normalized
# space the gesture tools take, or nothing when the node is not on screen.
_search_tap_point() { # udid
  run_tool describe "{\"udid\":\"$1\"}"
  printf '%s' "$RT_JSON" | jq -r '
    (.description // "")
    | [splits("\n")]
    | map(select(test("AXGroup \"Search\"")))
    | first // ""
    | capture("\\((?<x>[0-9.]+), (?<y>[0-9.]+), (?<w>[0-9.]+), (?<h>[0-9.]+)\\)")
    | (((.x|tonumber) + (.w|tonumber) / 2) | tostring) + " " + (((.y|tonumber) + (.h|tonumber) / 2) | tostring)
  ' 2>/dev/null
}

# What a read of the search field could not answer: a describe that failed, one
# with no `.description`, or a tree with no Search node at all. NOT "" — the
# empty string is the field's own answer when it holds nothing, and scoring the
# two the same made every unreadable device pass the one assertion in this tier
# that observes the field. Killing the transport mid-burst — the regression the
# header says this tier exists to catch — printed "search field emptied".
UNREADABLE='<unreadable>'

# What the search field currently HOLDS, from its own `describe` node: "" when
# the field is empty (the node then carries no `value=` at all), and $UNREADABLE
# when the read itself did not produce an answer.
#
# The marker test alone cannot see a forward-delete regression: with the caret
# one character from the end, backspaces alone leave exactly that character
# behind, and "the value no longer contains the marker" is true either way.
# Reading the value is what tells "Argentclearmark" from "k" (both measured on a
# real iOS 26.5 simulator).
_search_value() { # udid
  run_tool describe "{\"udid\":\"$1\"}"
  if [ "$RT_RC" -ne 0 ] || [ -z "$RT_JSON" ]; then
    printf '%s' "$UNREADABLE"; return
  fi
  local node
  node="$(printf '%s' "$RT_JSON" | jq -r '
    (.description // "")
    | [splits("\n")]
    | map(select(test("AXGroup \"Search\"")))
    | first // ""
  ' 2>/dev/null)"
  # The node itself missing is a read that failed, not an empty field: this tier
  # has already seen "Search" on screen by the time it asks.
  if [ -z "$node" ]; then
    printf '%s' "$UNREADABLE"; return
  fi
  case "$node" in
    *'value="'*) printf '%s' "${node#*value=\"}" | sed 's/".*//' ;;
    *) : ;; # the node is there and carries no value= — the field is empty
  esac
}

# Lowercased, for comparing against a UIKit search field that auto-capitalises
# the first character it is given.
_lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

run_phase() {
  local P=ios
  if [ "$E2E_OS" != darwin ]; then
    skip "$P" tier all "iOS simulators exist only on macOS"; return 0
  fi
  ensure_server || { skip "$P" tier all "tool-server unavailable"; return 0; }

  local DEV="${E2E_IOS_UDID:-}"
  if [ -z "$DEV" ]; then
    skip "$P" tier all "no simulator named (set E2E_IOS_UDID)"; return 0
  fi
  # The boot path the android tier has and this one lacked: on a cold
  # release-gate machine every assertion below was skipped, and the tier that
  # calls itself the only check that can go red for the HID burst went green
  # having run nothing.
  run_tool list-devices '{}'
  if ! printf '%s' "$RT_JSON" |
    jq -e --arg u "$DEV" 'any(.devices[]?; .udid==$u and .state=="Booted")' >/dev/null 2>&1; then
    log "booting simulator $DEV"
    run_tool boot-device "{\"udid\":\"$DEV\"}"
    if [ "$RT_RC" -ne 0 ]; then
      fail "$P" boot-device boot "$(rt_detail 160)"; return 0
    fi
    pass "$P" boot-device boot "booted $DEV"
  fi
  pass "$P" list-devices present "simulator $DEV"

  assert_true "$P" launch-app settings "{\"udid\":\"$DEV\",\"bundleId\":\"com.apple.Preferences\"}" '.launched'
  await_ui "$DEV" "Search"

  local POINT X Y
  POINT="$(_search_tap_point "$DEV")"
  # shellcheck disable=SC2086 # deliberate word split: "x y"
  set -- $POINT
  X="${1:-}"; Y="${2:-}"
  if [ -z "$X" ] || [ -z "$Y" ]; then
    # A FAILURE, not a skip: `await_ui` above has already seen "Search" on this
    # screen, so the precondition is met and the node not parsing out of
    # `describe` is a describe-format regression. Skipping scored that green in
    # the one tier whose header calls itself the only check that can go red.
    fail "$P" describe search-field "Settings' search field did not parse out of describe"; return 0
  fi
  assert_true "$P" gesture-tap focus-search "{\"udid\":\"$DEV\",\"x\":$X,\"y\":$Y}" '.tapped'

  # A distinctive marker, so the assertions cannot pass on some other node's text.
  # Every match below folds case first: a UIKit search field auto-capitalises the
  # first character, so the value reads back as "Argentclearmark".
  local MARK=argentclearmark
  assert_ok "$P" keyboard type-marker "{\"udid\":\"$DEV\",\"text\":\"$MARK\",\"delayMs\":30}"
  await_ui "$DEV" "$MARK"
  assert_field "$P" describe clear-baseline "{\"udid\":\"$DEV\"}" \
    "(.description|ascii_downcase|contains(\"$MARK\"))" 'true'

  # One `arrow-left` first, so the caret is NOT at the end. The burst is 100
  # backspaces interleaved with 100 forward-deletes, and with the caret at the
  # end the backspaces alone satisfy every assertion — deleting
  # FORWARD_DELETE_KEYCODE from it left this tier green. Measured on a real
  # iOS 26.5 simulator: from one character in, the full burst empties the field
  # and backspaces alone leave "k" behind.
  assert_ok "$P" keyboard caret-off-end "{\"udid\":\"$DEV\",\"key\":\"arrow-left\"}"
  # ...and the caret is OBSERVED to have moved, by typing into it: the exit code
  # of `arrow-left` says only that a key was sent. An arrow that stops landing
  # puts the caret back at the end, where backspaces alone empty the field and
  # the forward-delete half of the burst stops being load-bearing — the blind
  # spot this step was added to close, left open by asserting only the exit code.
  run_tool keyboard "{\"udid\":\"$DEV\",\"text\":\"z\",\"delayMs\":30}" >/dev/null 2>&1
  local SPLICED CARET
  SPLICED="${MARK%k}zk"
  CARET="$(_lc "$(_search_value "$DEV")")"
  if [ "$CARET" = "$SPLICED" ]; then
    pass "$P" keyboard caret-moved "field reads \"$CARET\""
  else
    fail "$P" keyboard caret-moved "expected \"$SPLICED\", field reads \"$CARET\""
  fi

  # The burst itself, in ONE call: `keys` is 200 — the CLEAR_KEY_PAIRS * 2
  # contract the tool description states to callers — and it cannot depend on
  # the device, so asserting it from a second burst only fires 200 more HID
  # events for nothing.
  assert_field "$P" keyboard clear "{\"udid\":\"$DEV\",\"clear\":true}" \
    '(.cleared == true and .keys == 200)' 'true'
  # What proves the HID deletes actually reached the field: its own value, not
  # the absence of the marker. See `_search_value` — the marker test passes for
  # a field still holding the character the forward-delete was meant to remove.
  local LEFT
  LEFT="$(_search_value "$DEV")"
  if [ "$LEFT" = "$UNREADABLE" ]; then
    # Not a pass: nothing was observed, so the burst is unverified. This is the
    # shape a dead transport takes — the very regression the tier exists for.
    fail "$P" describe clear-took-effect "the search field could not be read back"
  elif [ -z "$LEFT" ]; then
    pass "$P" describe clear-took-effect "search field emptied"
  else
    fail "$P" describe clear-took-effect "search field still holds \"$LEFT\""
  fi

  # One action per call, `clear` included — the same guard the other tiers make.
  # Matched on the message, not on the exit code: the rule is enforced in
  # `execute` rather than by the schema, so the rejection carries no zod issue
  # path and bare `assert_reject` passes on ANY non-zero exit — a device that
  # went away included.
  assert_reject_matching "$P" keyboard clear-and-text \
    "{\"udid\":\"$DEV\",\"clear\":true,\"text\":\"x\"}" \
    "keyboard takes one of"

  # Replace-a-value, the form the tool description prescribes: one round-trip,
  # and the field ends up holding ONLY the new text. The focus tap is its own
  # step with a settle, because `run-sequence` waits 100ms between steps and no
  # backend checks focus — the exact hazard the `clear` docs warn about.
  run_tool keyboard "{\"udid\":\"$DEV\",\"text\":\"$MARK\",\"delayMs\":30}" >/dev/null 2>&1
  await_ui "$DEV" "$MARK"
  assert_field "$P" run-sequence keyboard-clear-then-text \
    "{\"udid\":\"$DEV\",\"steps\":[{\"tool\":\"keyboard\",\"args\":{\"clear\":true}},{\"tool\":\"keyboard\",\"args\":{\"text\":\"replaced\",\"delayMs\":30}}]}" \
    '.completed' '2'
  await_ui "$DEV" "replaced"
  assert_field "$P" describe clear-then-retype "{\"udid\":\"$DEV\"}" \
    "((.description|ascii_downcase|contains(\"replaced\")) and ((.description|ascii_downcase|contains(\"$MARK\"))|not))" 'true'

  # Leave the simulator on a neutral screen rather than in a search with text.
  run_tool keyboard "{\"udid\":\"$DEV\",\"clear\":true}" >/dev/null 2>&1
  run_tool button "{\"udid\":\"$DEV\",\"button\":\"home\"}" >/dev/null 2>&1
}
