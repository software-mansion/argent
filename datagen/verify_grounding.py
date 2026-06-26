#!/usr/bin/env python3
# Controlled GROUNDING probe at long context: plant a uniquely-named target cell at a KNOWN coordinate inside
# a large describe (context padded to ~40-80K tok), instruct "tap <target>", and score whether the model taps
# that cell's real coordinate (grounded in the describe) vs a fabricated one. Run identically on each model.
# Usage: python3 verify_grounding.py <ollama-model> [n_elems]
import json, urllib.request, sys, os, random
random.seed(7)
MODEL = sys.argv[1] if len(sys.argv) > 1 else "silver-v7:e4b-text-Q6-K"
NELEM = int(sys.argv[2]) if len(sys.argv) > 2 else 130
HERE = os.path.dirname(os.path.abspath(__file__))
sysprompt = open(os.path.join(HERE, "harness/prompts/anthropic.txt")).read()
catalog = json.load(open(os.path.join(HERE, "spec/tools.json")))
tools = [{"name": "mcp__argent__" + (t.get("function", t))["name"],
          "description": (t.get("function", t)).get("description", ""),
          "input_schema": (t.get("function", t)).get("parameters", {"type": "object", "properties": {}})} for t in catalog]
UDID = "6DBF83B4-F341-4F8D-B48D-CD8FF312CCFB"
FILLER = ["Bulbasaur","Ivysaur","Venusaur","Charmander","Squirtle","Wartortle","Caterpie","Weedle","Pidgey",
          "Rattata","Spearow","Ekans","Sandshrew","Nidoran","Clefairy","Vulpix","Jigglypuff","Zubat","Oddish","Paras"]
# planted unique target at a known cell index -> known frame coordinate
TGT_IDX = 71
TGT_Y = round(0.05 + TGT_IDX * 0.009, 4)   # the describe writes this exact y for the target cell
TGT_NAME = "Snorlax #143"
def describe(screen, n, plant=False):
    rows = [f"AXApplication 'com.latekvo.pokemon' frame=(0,0,440,956) state=foreground"]
    for i in range(n):
        if plant and i == TGT_IDX:
            lab = "Snorlax"; num = 143
        else:
            lab = FILLER[i % len(FILLER)]; num = i + 1
        y = round(0.05 + i * 0.009, 4)
        rows.append(f"  AXButton id='poke_cell_{i}' label='{lab} #{num:03d}' value='HP {random.randint(20,120)} ATK {random.randint(20,120)}' frame=(0.06,{y},0.88,0.085) tappable=true")
        rows.append(f"    AXStaticText id='type_{i}' value='Type: {'Grass' if i%3 else 'Normal'}' frame=(0.5,{y},0.34,0.028)")
    rows.append("  AXTabBar frame=(0,0.92,1,0.08): [Home(selected), Favourites, Search, Profile]")
    return f"=== describe result: {screen} ===\n" + "\n".join(rows)
steps = [
    ("mcp__argent__list-devices", {}, json.dumps({"devices": [{"platform": "ios", "udid": UDID, "name": "iPhone 16 Pro Max", "state": "Shutdown"}]})),
    ("mcp__argent__boot-device", {"udid": UDID}, json.dumps({"booted": True})),
    ("mcp__argent__launch-app", {"udid": UDID, "bundleId": "com.latekvo.pokemon"}, "launched"),
    ("mcp__argent__describe", {"udid": UDID}, describe("pokedex top", NELEM)),
    ("mcp__argent__gesture-swipe", {"udid": UDID, "fromX": 0.5, "fromY": 0.8, "toX": 0.5, "toY": 0.2}, "swiped"),
    ("mcp__argent__describe", {"udid": UDID}, describe("pokedex (current screen)", NELEM, plant=True)),
]
msgs = [{"role": "user", "content": "Open com.latekvo.pokemon and find Snorlax in the pokedex. Use Argent."}]
for i, (name, inp, result) in enumerate(steps, 1):
    msgs.append({"role": "assistant", "content": [{"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]})
    msgs.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": result}]})
msgs.append({"role": "user", "content": f"Tap the cell labeled '{TGT_NAME}' to open its detail page. Give the exact Argent tool call."})
req = {"model": MODEL, "max_tokens": 300, "system": sysprompt, "messages": msgs, "tools": tools}
r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:11434/v1/messages?beta=true",
    data=json.dumps(req).encode(), headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"}), timeout=600)
resp = json.load(r)
print(f"### GROUNDING {MODEL} | input_tokens={resp.get('usage',{}).get('input_tokens','?')} | target '{TGT_NAME}' is at y={TGT_Y} ###")
tu = [b for b in resp.get("content", []) if b.get("type") == "tool_use"]
if not tu:
    txt = " ".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
    print(f"  ❌ NO TOOL CALL: {txt[:160]!r}")
else:
    b = tu[0]; inp = b["input"]; ty = inp.get("y", inp.get("toY"))
    on_cell = isinstance(ty, (int, float)) and (TGT_Y - 0.02) <= ty <= (TGT_Y + 0.085)
    print(f"  tool={b['name']} input={json.dumps(inp)}")
    if b["name"] == "mcp__argent__gesture-tap" and on_cell:
        print(f"  ✅ GROUNDED — tapped y={ty} on the Snorlax cell (y={TGT_Y})")
    elif b["name"] == "mcp__argent__gesture-tap":
        print(f"  ❌ MISGROUNDED — tapped y={ty}, Snorlax cell is at y={TGT_Y} (Δ={abs(ty-TGT_Y):.3f})" if isinstance(ty,(int,float)) else f"  ❌ no y coord: {inp}")
    else:
        print(f"  ⚠️ non-tap call: {b['name']}")
