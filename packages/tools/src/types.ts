import { z } from "zod";

export interface Tool<TSchema extends z.ZodObject<any>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: TSchema;
  outputSchema?: z.ZodSchema<TOutput>;
  requiresLicense?: boolean;
  execute(input: z.infer<TSchema>, signal?: AbortSignal): Promise<TOutput>;
}
