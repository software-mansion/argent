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
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodObjectToJsonSchema(tool.inputSchema),
    }));
  }
}

function zodObjectToJsonSchema(
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
  if (type instanceof z.ZodString) return { type: "string" };
  if (type instanceof z.ZodNumber) return { type: "number" };
  if (type instanceof z.ZodBoolean) return { type: "boolean" };
  if (type instanceof z.ZodOptional) return zodTypeToJsonSchema(type.unwrap());
  if (type instanceof z.ZodArray) {
    return { type: "array", items: zodTypeToJsonSchema(type.element) };
  }
  return {};
}

function isOptional(type: z.ZodTypeAny): boolean {
  return type instanceof z.ZodOptional;
}

export const registry = new ToolRegistry();
