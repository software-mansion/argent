import { expect } from "vitest";

/**
 * Assert `needle` appears exactly once. The recovery prose names the same actor
 * and the same tools in more than one clause, so a plain toContain stays green
 * after the clause it was written for is deleted.
 */
export function pinsOnce(haystack: string | undefined, needle: string, label?: string) {
  const where = label ? `${label}: ` : "";
  expect((haystack ?? "").split(needle).length - 1, `${where}exactly one "${needle}"`).toBe(1);
}
