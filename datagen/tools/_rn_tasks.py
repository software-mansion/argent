#!/usr/bin/env python3
"""Capture + self-verify RN pokemon navigation tasks. Each task runs from a clean
restart-app (the verification: clean start -> replay steps -> assert goal predicate).
Emits datagen/training/real-capture/rn_pokemon.json incrementally."""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from _rn_capture import Recorder, restart_clean, tree, UDID, PORT

OUT = os.path.join(os.path.dirname(__file__), "..", "training", "real-capture", "rn_pokemon.json")
OUT = os.path.abspath(OUT)

# ---- coordinate extraction from a verbatim component-tree ----
def coord_of(tree_text, label, kind=None):
    """Find '(tap: x,y)' for a node whose line contains `label`. If kind given, the
    line must also contain that node type. Returns (x,y) floats. Raises if not found."""
    for line in tree_text.splitlines():
        if label in line and (kind is None or kind in line):
            m = re.search(r"\(tap:\s*([-\d.]+),([-\d.]+)\)", line)
            if m:
                return float(m.group(1)), float(m.group(2))
    raise RuntimeError(f"label {label!r} (kind={kind}) not found in tree")

def compare_chip_count(tree_text):
    """Count chips in the top horizontal ScrollView on the Compare screen. The chip row is
    the FIRST 'ScrollView (tap: 0.50,0.21)'; its direct Text children are the chips."""
    lines = tree_text.splitlines()
    n = 0
    in_row = False
    for line in lines:
        if "ScrollView (tap: 0.50,0.21)" in line:
            in_row = True
            continue
        if in_row:
            # chip rows are indented under the first ScrollView; a new ScrollView ends it
            if "ScrollView" in line:
                break
            if re.search(r'Text "[a-z]', line):
                n += 1
    return n


def entry_coord(tree_text, name):
    """Coordinate of the PokemonExploreEntry container whose child Text == name.
    The entry line precedes its children; we find the child line then walk back to the
    nearest preceding PokemonExploreEntry line."""
    lines = tree_text.splitlines()
    target = None
    for i, line in enumerate(lines):
        if f'"{name}"' in line and "Text" in line:
            target = i
            break
    if target is None:
        raise RuntimeError(f"pokemon {name!r} not in tree")
    for j in range(target, -1, -1):
        if "PokemonExploreEntry" in lines[j]:
            m = re.search(r"\(tap:\s*([-\d.]+),([-\d.]+)\)", lines[j])
            return float(m.group(1)), float(m.group(2))
    raise RuntimeError(f"no PokemonExploreEntry above {name!r}")


def compare_chips_full():
    """All Compare chips (names + tap coords) from a NON-onscreen-clipped tree. The chip
    row scrolls horizontally so onScreenOnly hides chips past the right edge."""
    from _rn_capture import call as _call
    r = _call("debugger-component-tree", {"device_id": UDID, "port": PORT, "onScreenOnly": False})
    t = r["data"]
    out, seen = [], False
    for line in t.splitlines():
        if "ScrollView (tap: 0.50,0.21)" in line:
            seen = True
            continue
        if seen:
            if "ScrollView" in line:
                break
            m = re.search(r'Text "([a-z0-9-]+)" \(tap:\s*([-\d.]+),([-\d.]+)\)', line)
            if m:
                out.append((m.group(1), float(m.group(2)), float(m.group(3))))
    return out


def clear_compare():
    """Setup (NOT recorded): navigate to Compare and remove every chip so the recorded
    path starts from a deterministic empty queue. Run after restart_clean()."""
    from _rn_capture import tap as _tap
    import time as _t
    _tap(0.88, 0.96)  # Compare tab
    _t.sleep(1.3)
    for _ in range(12):
        chips = compare_chips_full()
        if not chips:
            return
        _, x, y = chips[0]
        _tap(x, y)
        _t.sleep(0.9)
    raise RuntimeError("could not clear Compare queue")


TASKS = []
def task(fn):
    TASKS.append(fn)
    return fn


# 1. Switch to the Saved (Favourites) tab.
@task
def t01(r):
    t = r.discover()
    x, y = coord_of(t, '"Saved"', "TabBarLabel")
    r.tap(x, y)
    final = r.discover()
    assert "Favourites" in final, "expected Favourites header"
    return dict(id="real-rnpokemon-01-saved-tab", kind="navigate-tap", diff="easy",
                gestures=["tap"],
                task="Open the Saved tab to view your favourite Pokemon.",
                answer="Opened the Saved tab; the Favourites screen is showing.")

# 2. Switch to the Map tab.
@task
def t02(r):
    t = r.discover()
    x, y = coord_of(t, '"Map"', "TabBarLabel")
    r.tap(x, y)
    final = r.discover()
    assert "Pokemon Map" in final, "expected Pokemon Map"
    return dict(id="real-rnpokemon-02-map-tab", kind="navigate-tap", diff="easy",
                gestures=["tap"],
                task="Switch to the Map tab to see nearby Pokemon on the map.",
                answer="Opened the Map tab; the Pokemon Map with nearby markers is showing.")

# 3. Switch to the Compare tab.
@task
def t03(r):
    t = r.discover()
    x, y = coord_of(t, '"Compare"', "TabBarLabel")
    r.tap(x, y)
    final = r.discover()
    assert "Pokemon Comparison" in final, "expected Comparison screen"
    return dict(id="real-rnpokemon-03-compare-tab", kind="navigate-tap", diff="easy",
                gestures=["tap"],
                task="Go to the Compare tab to compare Pokemon side by side.",
                answer="Opened the Compare tab; the Pokemon Comparison screen is showing.")

# 4. Expand a Pokemon card on Browse to reveal its stats (toggle).
@task
def t04(r):
    t = r.discover()
    x, y = entry_coord(t, "gloom")
    r.tap(x, y)
    final = r.discover()
    assert "StatBar" in final and "Strengths" in final, "expected expanded detail"
    return dict(id="real-rnpokemon-04-expand-card", kind="toggle", diff="easy",
                gestures=["tap"],
                task="On the Browse list, tap the Gloom card to expand its detailed stats.",
                answer="Expanded the Gloom card; its stats, strengths, weaknesses and moves are shown.")

# 5. Expand then collapse the Bulbasaur card (toggle round-trip).
@task
def t05(r):
    t = r.discover()
    x, y = entry_coord(t, "bulbasaur")
    r.tap(x, y)
    t2 = r.discover()
    assert "StatBar" in t2, "expected bulbasaur expanded"
    # collapse: tap the bulbasaur header again
    x2, y2 = coord_of(t2, '"bulbasaur"', "Text")
    r.tap(x2, y2)
    final = r.discover()
    assert "StatBar" not in final, "expected collapsed (no StatBar)"
    return dict(id="real-rnpokemon-05-expand-collapse", kind="toggle", diff="medium",
                gestures=["tap"],
                task="Expand the Bulbasaur card to read its stats, then collapse it again.",
                answer="Expanded Bulbasaur, read its stats, then collapsed the card back.")

# 6. Search the Browse list by ID to filter it.
@task
def t06(r):
    t = r.discover()
    x, y = coord_of(t, "Search by ID", "TextInput")
    r.tap(x, y)
    r.keyboard(text="22")
    final = r.discover()
    # filtered: fearow (#022) remains, bulbasaur (#001) should be gone
    assert '"bulbasaur"' not in final and '"fearow"' in final, "expected filtered list"
    return dict(id="real-rnpokemon-06-search-filter", kind="search", diff="medium",
                gestures=["tap"],
                task="Use the search box on Browse to filter the list to Pokemon with ID 22.",
                answer="Filtered the Browse list by ID 22; only matching Pokemon (fearow) remain.")

# 7. Load more Pokemon into the Browse list.
@task
def t07(r):
    t = r.discover()
    before = t.count("PokemonExploreEntry")
    x, y = coord_of(t, "Load More Pokemon", "Text")
    r.tap(x, y)
    final = r.discover()
    after = final.count("PokemonExploreEntry")
    assert after > before, f"expected more entries (before {before}, after {after})"
    return dict(id="real-rnpokemon-07-load-more", kind="navigate-tap", diff="easy",
                gestures=["tap"],
                task="Tap 'Load More Pokemon' on the Browse list to load additional Pokemon.",
                answer="Loaded more Pokemon; the Browse list now has additional entries.")

# 8. Scroll the Browse list to find a Pokemon below the fold (scroll-find).
@task
def t08(r):
    # first grow the list so there is something to scroll to
    t = r.discover()
    lx, ly = coord_of(t, "Load More Pokemon", "Text")
    r.tap(lx, ly)
    t2 = r.discover()
    top_names = set(re.findall(r'Text "([a-z][a-z0-9-]+)" \(tap', t2))
    # swipe up to scroll the list down (gesture-scroll is Chromium-only; iOS uses swipe)
    r.swipe(0.5, 0.8, 0.5, 0.2)
    final = r.discover()
    bot_names = set(re.findall(r'Text "([a-z][a-z0-9-]+)" \(tap', final))
    new = bot_names - top_names
    assert new, "expected new Pokemon revealed after scroll"
    return dict(id="real-rnpokemon-08-scroll-find", kind="scroll-find", diff="medium",
                gestures=["tap", "swipe"],
                task="Load more Pokemon, then scroll the Browse list down to reveal Pokemon further down the list.",
                answer="Scrolled the Browse list down; Pokemon further down the list are now visible.")

# 9. Queue a specific Pokemon for comparison by typing its ID and tapping Add.
#    (Compare state persists across restart, so setup clears the queue first — NOT recorded.)
@task
def t09(r):
    clear_compare()  # setup: deterministic empty Compare queue
    t = r.discover(onScreenOnly=False)  # already on Compare (cleared), now empty
    assert "Pokemon Comparison" in t and "No Comparisons Yet" in t
    ix, iy = coord_of(t, "Enter Pokemon ID", "TextInput")
    r.tap(ix, iy)
    r.keyboard(text="7")
    t2 = r.discover(onScreenOnly=False)
    ax, ay = coord_of(t2, '"Add"', "Text")
    r.tap(ax, ay)
    final = r.discover(onScreenOnly=False)
    assert '"squirtle"' in final, "expected squirtle (ID 7) chip added"  # ID 7 = squirtle (deterministic)
    return dict(id="real-rnpokemon-09-compare-by-id", kind="search", diff="medium",
                gestures=["tap"],
                task="On the Compare tab, enter Pokemon ID 7 in the input and tap Add to queue that Pokemon for comparison.",
                answer="Entered ID 7 and tapped Add; Squirtle is now queued in the comparison list.")

# 10. Add a random Pokemon to the Compare queue (count grows from empty to one).
@task
def t10(r):
    clear_compare()  # setup: deterministic empty Compare queue
    t = r.discover(onScreenOnly=False)
    assert "No Comparisons Yet" in t, "expected empty Compare to start"
    rx, ry = coord_of(t, '"Random"', "Text")
    r.tap(rx, ry)
    final = r.discover(onScreenOnly=False)
    after = compare_chip_count(final)
    assert after == 1, f"expected exactly one chip after Random from empty (got {after})"
    return dict(id="real-rnpokemon-10-compare-random", kind="navigate-tap", diff="medium",
                gestures=["tap"],
                task="On the Compare tab, add a random Pokemon to the comparison using the Random button.",
                answer="Tapped Random on Compare; a random Pokemon was added to the comparison queue.")

# 13. Remove a Pokemon from the Compare queue by tapping its chip.
@task
def t13(r):
    clear_compare()  # setup: empty, then seed two known chips so there is something to remove
    from _rn_capture import tap as _tap
    # seed two specific Pokemon (IDs 7=squirtle, 1=bulbasaur) so the removal target is known
    _tap(0.32, 0.16); time.sleep(0.4)
    from _rn_capture import call as _call
    _call("keyboard", {"udid": UDID, "text": "7"}); time.sleep(0.4)
    _tap(0.70, 0.16); time.sleep(1.0)   # Add squirtle
    _tap(0.32, 0.16); time.sleep(0.4)
    _call("keyboard", {"udid": UDID, "text": "1"}); time.sleep(0.4)
    _tap(0.70, 0.16); time.sleep(1.2)   # Add bulbasaur
    # record from here: two chips present, remove squirtle
    t = r.discover(onScreenOnly=False)
    before = compare_chip_count(t)
    assert '"squirtle"' in t and before == 2, f"expected 2 seeded chips (got {before})"
    sx, sy = coord_of(t, '"squirtle"', "Text")  # the chip row 'squirtle' (first match)
    r.tap(sx, sy)
    final = r.discover(onScreenOnly=False)
    after = compare_chip_count(final)
    assert after == before - 1 and '"squirtle"' not in final.split("ScrollView (tap: 0.50,0.57)")[0], \
        f"expected squirtle chip removed (before {before}, after {after})"
    return dict(id="real-rnpokemon-13-compare-remove", kind="toggle", diff="medium",
                gestures=["tap"],
                task="On the Compare tab with Squirtle and Bulbasaur queued, remove Squirtle from the comparison by tapping its chip.",
                answer="Tapped the Squirtle chip on Compare; it was removed, leaving Bulbasaur in the queue.")

# 11. Change the sort order on the Saved (Favourites) screen.
@task
def t11(r):
    t = r.discover()
    sx, sy = coord_of(t, '"Saved"', "TabBarLabel")
    r.tap(sx, sy)
    t2 = r.discover()
    assert "Favourites" in t2
    ix, iy = coord_of(t2, '"Id"', "Text")
    r.tap(ix, iy)
    final = r.discover()
    assert "Favourites" in final and '"Id"' in final, "still on Favourites with sort controls"
    assert final.count("PokemonExploreEntry") > 0, "saved list still populated after sorting"
    return dict(id="real-rnpokemon-11-saved-sort", kind="toggle", diff="medium",
                gestures=["tap"],
                task="On the Saved screen, change the sort order to sort the favourites by Id.",
                answer="Changed the Favourites sort to Id; the saved list is now ordered by Pokemon Id.")

# 12. Cross-tab navigation and return: Browse -> Map -> back to Browse.
@task
def t12(r):
    t = r.discover()
    mx, my = coord_of(t, '"Map"', "TabBarLabel")
    r.tap(mx, my)
    t2 = r.discover()
    assert "Pokemon Map" in t2
    bx, by = coord_of(t2, '"Browse"', "TabBarLabel")
    r.tap(bx, by)
    final = r.discover()
    assert "Search by ID" in final and "Pokemon Map" not in final, "expected back on Browse"
    return dict(id="real-rnpokemon-12-tab-roundtrip", kind="navigate-tap", diff="easy",
                gestures=["tap"],
                task="From Browse, open the Map tab, then return to the Browse tab.",
                answer="Navigated Browse -> Map -> Browse; back on the Browse list.")


def build_meta(d):
    return {"id": d["id"], "app": "latekvo__pokemon", "platform": "ios",
            "task_kind": d["kind"], "source": "real", "difficulty": d["diff"],
            "bundleId": "com.latekvo.pokemon", "device": UDID,
            "gestures": d["gestures"], "verified": True, "notes": "react-native"}


def main():
    only = sys.argv[1:] or None  # optional task-id substrings to run
    results = []
    if os.path.exists(OUT):
        with open(OUT) as f:
            results = json.load(f)
    by_id = {r["meta"]["id"]: r for r in results}
    for fn in TASKS:
        # peek the id by running fn name mapping is awkward; just run and key by returned id
        print(f"\n=== running {fn.__name__} ===", flush=True)
        restart_clean()
        r = Recorder()
        try:
            d = fn(r)
        except Exception as e:
            print(f"  FAILED: {e}", flush=True)
            continue
        if only and not any(o in d["id"] for o in only):
            continue
        traj = {"meta": build_meta(d), "task": d["task"], "tools": [],
                "steps": r.steps, "finalAnswer": d["answer"]}
        by_id[d["id"]] = traj
        # write incrementally, preserving task order by id
        ordered = [by_id[k] for k in sorted(by_id)]
        with open(OUT, "w") as f:
            json.dump(ordered, f, indent=2, ensure_ascii=False)
        print(f"  OK {d['id']} ({len(r.steps)} steps) -> wrote {len(ordered)} trajectories",
              flush=True)
    print(f"\nDONE -> {OUT}", flush=True)


if __name__ == "__main__":
    main()
