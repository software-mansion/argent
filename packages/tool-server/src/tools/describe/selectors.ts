import { z } from "zod";
import type { DescribeNode } from "./contract";

// Shared selector contract for tools that inspect the describe tree. Every
// supplied field is required to match; individual matches are
// case-insensitive substrings so callers do not need platform-exact labels.
export const describeSelectorSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .optional()
      .describe("Case-insensitive substring of the element's visible label or value."),
    identifier: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Case-insensitive substring of the element's identifier (accessibilityIdentifier / resource-id / testid)."
      ),
    role: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Case-insensitive substring of the element's role (e.g. AXButton, button, TextView)."
      ),
    package: z
      .string()
      .min(1)
      .optional()
      .describe("Case-insensitive substring of the native package owning the element (Android)."),
  })
  .refine(
    (selector) =>
      Boolean(selector.text || selector.identifier || selector.role || selector.package),
    {
      message: "selector needs at least one of text, identifier, role, or package",
    }
  );

export type DescribeSelector = z.infer<typeof describeSelectorSchema>;

function includesCaseInsensitive(haystack: string | undefined, needle: string): boolean {
  return Boolean(haystack) && haystack!.toLowerCase().includes(needle.toLowerCase());
}

export function matchesDescribeSelector(node: DescribeNode, selector: DescribeSelector): boolean {
  if (
    selector.text !== undefined &&
    !includesCaseInsensitive(node.label, selector.text) &&
    !includesCaseInsensitive(node.value, selector.text)
  ) {
    return false;
  }
  if (
    selector.identifier !== undefined &&
    !includesCaseInsensitive(node.identifier, selector.identifier)
  ) {
    return false;
  }
  if (selector.role !== undefined && !includesCaseInsensitive(node.role, selector.role)) {
    return false;
  }
  if (
    selector.package !== undefined &&
    !includesCaseInsensitive(node.packageName, selector.package)
  ) {
    return false;
  }
  return true;
}

function collectMatches(
  node: DescribeNode,
  selector: DescribeSelector,
  matches: DescribeNode[]
): void {
  if (matchesDescribeSelector(node, selector)) matches.push(node);
  for (const child of node.children) collectMatches(child, selector, matches);
}

// The root is a synthetic/non-selectable container in public describe output,
// so selectors consistently start at its children.
export function findDescribeMatches(
  root: DescribeNode,
  selector: DescribeSelector
): DescribeNode[] {
  const matches: DescribeNode[] = [];
  for (const child of root.children) collectMatches(child, selector, matches);
  return matches;
}
