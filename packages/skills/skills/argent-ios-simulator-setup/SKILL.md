---
name: argent-ios-simulator-setup
description: Set up and connect to an iOS simulator using argent MCP tools. Use when starting a new session, booting an iOS simulator, getting an iOS UDID, or before any iOS simulator interaction task.
---

## 1. Setup Steps

If you delegate simulator tasks to sub-agents, make sure they have MCP permissions.

1. **Find a booted simulator**
   Use `list-devices`. Filter for entries with `platform: "ios"` **and `kind: "simulator"`** — a
   connected physical iPhone is also a `platform: "ios"` entry, reports `state: "connected"`, and is
   listed ahead of a shut-down simulator, so filtering on platform alone picks the phone. Booted
   simulators come first within that set. If none are booted, call `boot-device` with
   `udid: <chosen UDID>`.

2. **Verify connection**
   All interaction tools (`gesture-tap`, `gesture-swipe`, `gesture-custom`, etc.) auto-start the server if not already running.

## 2. Notes

- Simulator UDIDs look like: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`. A physical iPhone's is a different shape (`00008120-000E6D0C0ABBA01E`) and is not a simulator — see the README's physical-iOS section.
