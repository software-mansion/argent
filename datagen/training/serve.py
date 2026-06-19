#!/usr/bin/env python3
"""Persistent mlx-lm generation server.

Loads a model (optionally with a LoRA adapter) once, then serves one generation
per stdin line as JSON: {"messages": [{role, content}...], "max_tokens": N}.
Applies the model's chat template (so Gemma's user/model turns are correct) and
writes {"text": completion} per line to stdout. Greedy decoding for a
deterministic benchmark. Emits "READY" on stderr once the model is loaded.
"""
import sys
import json
import argparse

from mlx_lm import load, generate

try:
    from mlx_lm.sample_utils import make_sampler

    GREEDY = make_sampler(temp=0.0)
except Exception:  # pragma: no cover - version differences
    GREEDY = None


def gen(model, tok, prompt, max_tokens):
    kwargs = {"max_tokens": max_tokens, "verbose": False}
    if GREEDY is not None:
        kwargs["sampler"] = GREEDY
    try:
        return generate(model, tok, prompt, **kwargs)
    except TypeError:
        # Older signature without sampler kwarg.
        return generate(model, tok, prompt, max_tokens=max_tokens, verbose=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--adapter-path", default=None)
    ap.add_argument("--max-tokens", type=int, default=256)
    args = ap.parse_args()

    model, tok = load(args.model, adapter_path=args.adapter_path)
    sys.stderr.write("READY\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            messages = req["messages"]
            max_tokens = int(req.get("max_tokens", args.max_tokens))
            prompt = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
            text = gen(model, tok, prompt, max_tokens)
            sys.stdout.write(json.dumps({"text": text}) + "\n")
        except Exception as e:  # never die mid-eval; report the error per request
            sys.stdout.write(json.dumps({"text": "", "error": str(e)}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
