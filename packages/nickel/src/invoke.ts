// Nickel reaches argent's own tools (describe / gesture-tap / keyboard / screenshot)
// in-process through the registry — no duplication, no HTTP hop. This module is the
// one place that binding lives, plus the minimal slice of the `describe` contract
// Nickel depends on (the full DescribeResult lives in tool-server, which depends on
// this package — importing it would be circular).

import type { Registry, ToolContext } from "@argent/registry";
import { parseDescribe, type Screen } from "./describe/screen";

/** A thin binding over registry.invokeTool, propagating the caller's abort signal. */
export type Invoke = <T>(id: string, args: unknown) => Promise<T>;

export function bindInvoke(registry: Registry, ctx?: ToolContext): Invoke {
  const signal = ctx?.signal;
  return <T>(id: string, args: unknown) =>
    registry.invokeTool<T>(id, args, signal ? { signal } : undefined);
}

interface DescribeResult {
  description?: string;
}

/** Observe the live screen: argent `describe` → normalized Screen. */
export async function observeScreen(invoke: Invoke, udid: string): Promise<Screen> {
  const d = await invoke<DescribeResult>("describe", { udid });
  return parseDescribe(d.description ?? "");
}
