#!/usr/bin/env python3
# Real-path verification: hits ollama's /v1/messages (the Claude Code path) with a REALISTIC large prompt
# + the full argent tool catalog, runs a multi-step nav scenario, and checks the model emits VALID tool
# calls with REAL argument values (not the parameter schema) + correct tool names. This is the test that
# catches the schema-as-args bug. Usage: python3 verify_realpath.py <ollama-model-name>
import json, urllib.request, sys, os
MODEL = sys.argv[1] if len(sys.argv) > 1 else "silver-v6:e4b-text-Q6-K"
HERE = os.path.dirname(os.path.abspath(__file__))
# realistic large system prompt (a real provider prompt) + full argent catalog in Anthropic tool format
sysprompt = open(os.path.join(HERE, "harness/prompts/anthropic.txt")).read()
catalog = json.load(open(os.path.join(HERE, "spec/tools.json")))
def to_anthropic(t):
    f = t.get("function", t)
    return {"name": "mcp__argent__" + f["name"], "description": f.get("description", ""),
            "input_schema": f.get("parameters", {"type": "object", "properties": {}})}
tools = [to_anthropic(t) for t in catalog]  # full 67-tool catalog
UDID = "6DBF83B4-F341-4F8D-B48D-CD8FF312CCFB"
def ask(messages):
    req = {"model": MODEL, "max_tokens": 500, "system": sysprompt, "messages": messages, "tools": tools}
    r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:11434/v1/messages?beta=true",
        data=json.dumps(req).encode(), headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"}), timeout=180)
    return json.load(r)
def tool_uses(resp):
    return [b for b in resp.get("content", []) if b.get("type") == "tool_use"]
def is_schema_junk(inp):  # detect the schema-as-args bug
    s = json.dumps(inp)
    return any(k in s for k in ['"properties"', '"type":"OBJECT"', '"type": "STRING"', '"required"'])

print(f"### REAL-PATH VERIFY: {MODEL} (full {len(tools)}-tool catalog + {len(sysprompt)//4}tok prompt) ###")
scenarios = [
    ("boot a device", [{"role": "user", "content": "Boot an iOS device and launch com.latekvo.pokemon, then go to the Favourites tab. Use Argent."}]),
]
# multi-turn: after list-devices result
msgs = [{"role": "user", "content": "Boot an iOS device and open com.latekvo.pokemon. Use Argent."},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "mcp__argent__list-devices", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": json.dumps({"devices": [{"platform": "ios", "udid": UDID, "name": "iPhone 16 Pro Max", "state": "Shutdown"}]})}]}]
try:
    resp = ask(msgs)
    tu = tool_uses(resp)
    if not tu:
        txt = " ".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
        print(f"  ❌ NO TOOL CALL — derailed to text: {txt[:120]!r}")
    else:
        b = tu[0]
        junk = is_schema_junk(b["input"])
        print(f"  tool={b['name']} input={json.dumps(b['input'])[:120]}")
        print(f"  {'❌ SCHEMA-AS-ARGS BUG' if junk else '✅ real args'} | name {'✅' if b['name'].startswith('mcp__argent__') and any(b['name']==t['name'] for t in tools) else '⚠️ hallucinated/odd'}")
except Exception as e:
    print(f"  ERROR (is ollama running?): {type(e).__name__}: {str(e)[:120]}")
