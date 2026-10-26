---
name: argent-ios-simulator-setup
description: Set up and connect to an iOS simulator using argent MCP tools. Use when starting a new session, booting an iOS simulator, getting an iOS UDID, or before any iOS simulator interaction task.
---

## 1. Setup Steps

1. **Find a booted simulator.** Use `list-devices`. Filter for entries with `platform: "ios"` and skip any with `kind: "device"` (a physical iPhone, never a simulator target): booted simulators are listed first. If none are booted, call `boot-device` with `udid: <chosen UDID>`.
2. **No connect step.** Interaction tools (`gesture-tap`, `describe`, `screenshot`, …) auto-start the simulator server on first use.

## 2. Notes

- If you delegate simulator tasks to sub-agents, make sure they have MCP permissions.
