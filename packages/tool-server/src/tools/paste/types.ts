import type { z } from "zod";
import type { pasteZodSchema } from "./schema";

export type PasteParams = z.infer<typeof pasteZodSchema>;

export interface PasteResult {
  pasted: true;
}

/**
 * No declared services: each branch resolves simulator-server lazily, after
 * rejecting a TV target.
 */
export type PasteServices = Record<string, never>;
