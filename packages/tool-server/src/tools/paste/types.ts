import type { z } from "zod";
import type { pasteZodSchema } from "./schema";

export type PasteParams = z.infer<typeof pasteZodSchema>;

export interface PasteResult {
  pasted: true;
}

/**
 * Every branch resolves its simulator-server lazily (a TV target must never
 * spawn one), so the tool declares no services.
 */
export type PasteServices = Record<string, never>;
