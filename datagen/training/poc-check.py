#!/usr/bin/env python3
"""Quick check: does the PoC-tuned model emit gemma4-NATIVE tool calls?

Loads base + the PoC LoRA adapter, renders an OpenCode-style request (system rules
+ a few tools + a task) through the gemma4 chat template (add_generation_prompt),
and generates. Success = the output begins a `<|tool_call>call:...<tool_call|>`
(the native format PARSER gemma4 parses), NOT `<tool_call>` text or plain prose.
"""
import json
from pathlib import Path
from mlx_lm.utils import load_model, load_tokenizer
from mlx_lm import generate
from mlx_lm.sample_utils import make_sampler

ADAPTER = "adapters/native-poc"
base, _ = load_model(Path("base/gemma-4-e4b-clean"), strict=True)
from mlx_lm.tuner.utils import load_adapters

load_adapters(base, ADAPTER)
tok = load_tokenizer(Path("base/gemma-4-e4b-clean"))

SYSTEM = "You are an agent that drives mobile apps through the Argent toolkit. Call list-devices first; use describe before tapping; coordinates are normalized 0-1."
tools = [
    {"type": "function", "function": {"name": "list-devices", "description": "List simulators/emulators", "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "launch-app", "description": "Open an app by bundle id", "parameters": {"type": "object", "properties": {"udid": {"type": "string"}, "bundleId": {"type": "string"}}, "required": ["udid", "bundleId"]}}},
    {"type": "function", "function": {"name": "describe", "description": "Get the on-screen element tree", "parameters": {"type": "object", "properties": {"udid": {"type": "string"}}, "required": ["udid"]}}},
    {"type": "function", "function": {"name": "gesture-tap", "description": "Tap at normalized x,y", "parameters": {"type": "object", "properties": {"udid": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}}, "required": ["udid", "x", "y"]}}},
]

for task in ["Open the Settings app and go to General > About.", "List the available devices."]:
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": task}]
    prompt = tok.apply_chat_template(msgs, tools=tools, add_generation_prompt=True, tokenize=False)
    out = generate(base, tok, prompt, max_tokens=80, verbose=False, sampler=make_sampler(temp=0.0))
    native = "<|tool_call>" in out
    print(f"=== task: {task}")
    print("  NATIVE tool-call format:" , "YES ✅" if native else "NO ❌")
    print("  raw:", repr(out[:160]))
