import { z } from "zod";

export function zodObjectToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
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
  if (type instanceof z.ZodDefault) {
    return { ...zodTypeToJsonSchema(type._def.innerType), default: type._def.defaultValue() };
  }
  if (type instanceof z.ZodArray) {
    return { type: "array", items: zodTypeToJsonSchema(type.element) };
  }
  if (type instanceof z.ZodObject) {
    return zodObjectToJsonSchema(type);
  }
  if (type instanceof z.ZodRecord) {
    return { type: "object" };
  }
  if (type instanceof z.ZodEnum) {
    return { type: "string", enum: type.options };
  }
  return {};
}

function isOptional(type: z.ZodTypeAny): boolean {
  return type instanceof z.ZodOptional || type instanceof z.ZodDefault;
}
