---
name: argent-ios-simulator-setup
description: Boot an iOS simulator and find its UDID with Argent. Use only when no simulator is booted yet or you need to pick and boot one.
---

## 1. Setup Steps

1. **Find a booted simulator.** Use `list-devices`. Filter for entries with `platform: "ios"` and skip `kind: "device"` (a physical iPhone): booted simulators are listed first. Through MCP, simulators that are shut down follow the JSON object, one line each, with the udid second. If no fitting simulator is booted, call `boot-device` with `udid: <chosen UDID>`.
2. **No connect step.** Interaction tools (`gesture-tap`, `describe`, `screenshot`, …) auto-start the simulator server on first use.

## 2. Notes

- If you delegate simulator tasks to sub-agents, make sure they have MCP permissions.
