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
  const description = readDescription(schema);
  if (description) result.description = description;
  return result;
}

function zodTypeToJsonSchema(type: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap ZodDefault first so the default value and the description land on
  // the JSON Schema produced for the inner type. `.describe()` called before
  // or after `.default()` both work because we collect the description from
  // every wrapper we traverse.
  let schema: Record<string, unknown>;
  let defaultValue: unknown;
  const descriptions: string[] = [];
  let current: z.ZodTypeAny = type;

  while (true) {
    const desc = readDescription(current);
    if (desc) descriptions.push(desc);

    if (current instanceof z.ZodDefault) {
      try {
        defaultValue = (current._def as { defaultValue: () => unknown }).defaultValue();
      } catch {
        // If the default throws during introspection, skip it — the default still
        // applies at runtime but JSON Schema consumers don't need to see it.
      }
      current = (current._def as { innerType: z.ZodTypeAny }).innerType;
      continue;
    }

    if (current instanceof z.ZodOptional) {
      current = current.unwrap();
      continue;
    }

    if (current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }

    if (current instanceof z.ZodEffects) {
      current = (current._def as { schema: z.ZodTypeAny }).schema;
      continue;
    }

    break;
  }

  if (current instanceof z.ZodString) schema = { type: "string" };
  else if (current instanceof z.ZodNumber) schema = { type: "number" };
  else if (current instanceof z.ZodBoolean) schema = { type: "boolean" };
  else if (current instanceof z.ZodLiteral) schema = literalSchema(current);
  else if (current instanceof z.ZodArray) {
    schema = { type: "array", items: zodTypeToJsonSchema(current.element) };
  } else if (current instanceof z.ZodObject) {
    schema = zodObjectToJsonSchema(current);
  } else if (current instanceof z.ZodRecord) {
    schema = { type: "object" };
  } else if (current instanceof z.ZodEnum) {
    schema = { type: "string", enum: current.options };
  } else if (current instanceof z.ZodUnion) {
    schema = {
      anyOf: (current._def as { options: z.ZodTypeAny[] }).options.map(zodTypeToJsonSchema),
    };
  } else {
    schema = {};
  }

  if (defaultValue !== undefined) schema.default = defaultValue;
  // Prefer the outermost description (users typically call `.describe()` last).
  if (descriptions.length > 0 && schema.description === undefined) {
    schema.description = descriptions[0];
  }
  return schema;
}

function literalSchema(type: z.ZodTypeAny): Record<string, unknown> {
  const value = (type._def as { value: unknown }).value;
  const jsType = typeof value;
  if (jsType === "string" || jsType === "number" || jsType === "boolean") {
    return { type: jsType, const: value };
  }
  return { const: value };
}

function readDescription(type: z.ZodTypeAny): string | undefined {
  const def = (type as { _def?: { description?: unknown } })._def;
  const description = def?.description;
  return typeof description === "string" && description.length > 0 ? description : undefined;
}

function isOptional(type: z.ZodTypeAny): boolean {
  if (type instanceof z.ZodOptional) return true;
  if (type instanceof z.ZodDefault) return true;
  return false;
}
