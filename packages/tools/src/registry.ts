import { z } from "zod";
import { Tool } from "./types";

export class ToolRegistry {
  private tools = new Map<string, Tool<any, any>>();

  register<TSchema extends z.ZodObject<any>, TOutput>(
    tool: Tool<TSchema, TOutput>
  ): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<any, any> | undefined {
    return this.tools.get(name);
  }

  list(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputHint?: string;
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodObjectToJsonSchema(tool.inputSchema),
      ...(tool.outputHint ? { outputHint: tool.outputHint } : {}),
    }));
  }
}

export function zodObjectToJsonSchema(
  schema: z.ZodObject<any>
): Record<string, unknown> {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodTypeToJsonSchema(value);
    if (!isOptional(value)) {
      required.push(key);
    }
  }

  const result: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) {
    result.required = required;
  }
  return result;
}

function zodTypeToJsonSchema(type: z.ZodTypeAny): Record<string, unknown> {
  const description = (type as any)._def?.description as string | undefined;
  const inner = type instanceof z.ZodOptional ? type.unwrap() : type;

  let schema: Record<string, unknown>;
  if (inner instanceof z.ZodString) schema = { type: "string" };
  else if (inner instanceof z.ZodNumber) schema = { type: "number" };
  else if (inner instanceof z.ZodBoolean) schema = { type: "boolean" };
  else if (inner instanceof z.ZodEnum)
    schema = { type: "string", enum: inner.options };
  else if (inner instanceof z.ZodArray)
    schema = { type: "array", items: zodTypeToJsonSchema(inner.element) };
  else if (inner instanceof z.ZodObject) schema = zodObjectToJsonSchema(inner);
  else schema = {};

  if (description) schema.description = description;
  return schema;
}

function isOptional(type: z.ZodTypeAny): boolean {
  return type instanceof z.ZodOptional;
}

export const registry = new ToolRegistry();
