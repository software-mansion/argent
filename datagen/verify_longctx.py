#!/usr/bin/env python3
# LONG-CONTEXT real-path verify: the test that actually justifies the v7 run. Builds a realistic multi-turn
# nav session with large accumulated `describe` dumps (~30-50K tokens) — the regime where v6 is reported to
# degrade (passed ~18K, broke ~55K) — and checks the model still emits a VALID tool call (real args + valid
# name, not schema junk / not derailed to text). Identical history for every model (seeded).
# Usage: python3 verify_longctx.py <ollama-model> [n_elems_per_describe]
import json, urllib.request, sys, os, random
random.seed(0)
MODEL = sys.argv[1] if len(sys.argv) > 1 else "silver-v7:e4b-text-Q6-K"
NELEM = int(sys.argv[2]) if len(sys.argv) > 2 else 130
HERE = os.path.dirname(os.path.abspath(__file__))
sysprompt = open(os.path.join(HERE, "harness/prompts/anthropic.txt")).read()
catalog = json.load(open(os.path.join(HERE, "spec/tools.json")))
def to_anthropic(t):
    f = t.get("function", t)
    return {"name": "mcp__argent__" + f["name"], "description": f.get("description", ""),
            "input_schema": f.get("parameters", {"type": "object", "properties": {}})}
tools = [to_anthropic(t) for t in catalog]
UDID = "6DBF83B4-F341-4F8D-B48D-CD8FF312CCFB"
LABELS = ["Bulbasaur","Ivysaur","Venusaur","Charmander","Charmeleon","Charizard","Squirtle","Wartortle",
          "Blastoise","Caterpie","Metapod","Butterfree","Weedle","Kakuna","Beedrill","Pidgey","Pidgeotto",
          "Pidgeot","Rattata","Raticate","Spearow","Fearow","Ekans","Arbok","Pikachu","Raichu"]
def big_describe(screen, n):
    rows = [f"AXApplication 'com.latekvo.pokemon' frame=(0,0,440,956) state=foreground"]
    for i in range(n):
        lab = LABELS[i % len(LABELS)]; y = 0.05 + (i * 0.009)
        rows.append(f"  AXButton id='poke_cell_{i}' label='{lab} #{i+1:03d}' value='HP {random.randint(20,120)} ATK {random.randint(20,120)} DEF {random.randint(20,120)}' frame=(0.06,{y:.4f},0.88,0.085) tappable=true enabled=true")
        rows.append(f"    AXImage id='sprite_{i}' label='{lab} front sprite' frame=(0.08,{y:.4f},0.12,0.07)")
        rows.append(f"    AXStaticText id='type_{i}' value='Type: {'Grass' if i%3==0 else 'Fire' if i%3==1 else 'Water'} | Gen {1+i%3}' frame=(0.5,{y:.4f},0.34,0.028)")
    rows.append("  AXTabBar frame=(0,0.92,1,0.08): [Home(selected), Favourites, Search, Profile]")
    return f"=== describe result: {screen} ===\n" + "\n".join(rows)
steps = [
    ("mcp__argent__list-devices", {}, json.dumps({"devices": [{"platform": "ios", "udid": UDID, "name": "iPhone 16 Pro Max", "state": "Shutdown"}]})),
    ("mcp__argent__boot-device", {"udid": UDID}, json.dumps({"booted": True, "udid": UDID})),
    ("mcp__argent__launch-app", {"udid": UDID, "bundleId": "com.latekvo.pokemon"}, "app com.latekvo.pokemon launched"),
    ("mcp__argent__describe", {"udid": UDID}, big_describe("home pokedex list (top)", NELEM)),
    ("mcp__argent__gesture-swipe", {"udid": UDID, "fromX": 0.5, "fromY": 0.8, "toX": 0.5, "toY": 0.2}, "swiped up"),
    ("mcp__argent__describe", {"udid": UDID}, big_describe("home pokedex list (scrolled)", NELEM)),
    ("mcp__argent__gesture-tap", {"udid": UDID, "x": 0.4, "y": 0.95}, "tapped Favourites tab"),
    ("mcp__argent__describe", {"udid": UDID}, big_describe("favourites tab (empty)", NELEM)),
]
msgs = [{"role": "user", "content": "Open com.latekvo.pokemon, go to the Favourites tab, then favourite Charizard. Use Argent."}]
for i, (name, inp, result) in enumerate(steps, 1):
    msgs.append({"role": "assistant", "content": [{"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]})
    msgs.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": result}]})
msgs.append({"role": "user", "content": "Charizard isn't in Favourites yet. Go back to the pokedex and favourite Charizard. What is your next Argent tool call?"})
def ask(messages):
    req = {"model": MODEL, "max_tokens": 400, "system": sysprompt, "messages": messages, "tools": tools}
    r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:11434/v1/messages?beta=true",
        data=json.dumps(req).encode(), headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"}), timeout=600)
    return json.load(r)
def is_schema_junk(inp):
    s = json.dumps(inp); return any(k in s for k in ['"properties"', '"type":"OBJECT"', '"type": "STRING"', '"required"', '"description":'])
resp = ask(msgs)
usage = resp.get("usage", {})
print(f"### LONG-CTX VERIFY {MODEL} | input_tokens={usage.get('input_tokens','?')} ###")
tu = [b for b in resp.get("content", []) if b.get("type") == "tool_use"]
if not tu:
    txt = " ".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
    print(f"  ❌ NO TOOL CALL — derailed to text: {txt[:200]!r}")
else:
    b = tu[0]; junk = is_schema_junk(b["input"])
    validname = b["name"].startswith("mcp__argent__") and any(b["name"] == t["name"] for t in tools)
    print(f"  tool={b['name']} input={json.dumps(b['input'])[:200]}")
    print(f"  {'❌ SCHEMA-AS-ARGS BUG' if junk else '✅ real args'} | name {'✅ valid' if validname else '⚠️ hallucinated/odd: '+b['name']}")
