#!/usr/bin/env python3
"""Quick QA over real-capture trajectories. Usage: python3 tools/capture-qa.py [dir]"""
import json, sys, os, collections

CANON = {"list-devices","launch-app","open-url","restart-app","describe","gesture-tap",
         "gesture-swipe","gesture-scroll","gesture-pinch","gesture-rotate","gesture-drag",
         "keyboard","button","screenshot","debugger-component-tree"}
GESTURE = {"gesture-tap","gesture-swipe","gesture-scroll","gesture-pinch","gesture-rotate","gesture-drag"}

def main():
    d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "training", "real-capture")
    files = sorted(f for f in os.listdir(d) if f.endswith(".json")) if os.path.isdir(d) else []
    tot_traj = tot_ver = tot_steps = 0
    gest = collections.Counter()
    apps = 0
    print(f"{'app':38} {'traj':>4} {'ver':>4} {'avgstep':>7} {'gestures'}")
    for f in files:
        try:
            arr = json.load(open(os.path.join(d, f)))
        except Exception as e:
            print(f"{f:38} PARSE ERROR: {e}"); continue
        if not isinstance(arr, list): arr = [arr]
        if not arr: continue
        apps += 1
        ver = sum(1 for t in arr if (t.get("meta") or {}).get("verified"))
        steps = [len(t.get("steps") or []) for t in arr]
        g = collections.Counter()
        bad = []
        for t in arr:
            for s in (t.get("steps") or []):
                nm = (s.get("call") or {}).get("name")
                if nm in GESTURE: g[nm] += 1; gest[nm] += 1
                if nm and nm not in CANON: bad.append(nm)
        tot_traj += len(arr); tot_ver += ver; tot_steps += sum(steps)
        gs = ",".join(f"{k.split('-')[1]}:{v}" for k, v in g.most_common())
        warn = f"  !! non-canonical: {set(bad)}" if bad else ""
        print(f"{f[:-5][:38]:38} {len(arr):>4} {ver:>4} {sum(steps)/max(1,len(steps)):>7.1f} {gs}{warn}")
    print(f"\nTOTAL: {apps} apps, {tot_traj} trajectories ({tot_ver} verified), "
          f"{tot_steps} steps, gestures={dict(gest)}")
    print(f"  -> x4 harnesses = {tot_traj*4} training rows from real capture")

if __name__ == "__main__":
    main()
