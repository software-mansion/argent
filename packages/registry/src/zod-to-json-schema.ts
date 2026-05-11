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
  // `.describe()` may sit on any wrapper. Read it before unwrapping so the outer
  // description (the one the tool author last wrote) wins over any inner one.
  const description = type.description;

  // ZodDefault wraps a base type with a callable default. Unwrap, carry the
  // default value into the emitted schema so downstream consumers (MCP clients,
  // JSON-schema validators) see what value will be used if the caller omits it.
  if (type instanceof z.ZodDefault) {
    const base = zodTypeToJsonSchema(type._def.innerType);
    const defaultValue = type._def.defaultValue();
    return withDescription({ ...base, default: defaultValue }, description);
  }

  // ZodOptional + ZodNullable are both modelled as "absence of value" in JSON
  // Schema terms; the caller side just marks them non-required. We pass through
  // the inner type's emitted schema so `z.string().optional()` still reads as
  // `{ type: "string" }` rather than `{}`.
  if (type instanceof z.ZodOptional) {
    return withDescription(zodTypeToJsonSchema(type.unwrap()), description);
  }
  if (type instanceof z.ZodNullable) {
    return withDescription(zodTypeToJsonSchema(type.unwrap()), description);
  }

  if (type instanceof z.ZodString) return withDescription({ type: "string" }, description);
  if (type instanceof z.ZodNumber) return withDescription({ type: "number" }, description);
  if (type instanceof z.ZodBoolean) return withDescription({ type: "boolean" }, description);
  if (type instanceof z.ZodLiteral) {
    return withDescription({ const: type._def.value }, description);
  }
  if (type instanceof z.ZodUnion) {
    const anyOf = (type._def.options as z.ZodTypeAny[]).map(zodTypeToJsonSchema);
    return withDescription({ anyOf }, description);
  }
  if (type instanceof z.ZodArray) {
    return withDescription(
      { type: "array", items: zodTypeToJsonSchema(type.element) },
      description
    );
  }
  if (type instanceof z.ZodObject) {
    return withDescription(zodObjectToJsonSchema(type), description);
  }
  if (type instanceof z.ZodRecord) {
    return withDescription({ type: "object" }, description);
  }
  if (type instanceof z.ZodEnum) {
    return withDescription({ type: "string", enum: type.options }, description);
  }
  return withDescription({}, description);
}

function withDescription(
  schema: Record<string, unknown>,
  description: string | undefined
): Record<string, unknown> {
  if (description && !("description" in schema)) {
    return { ...schema, description };
  }
  return schema;
}

function isOptional(type: z.ZodTypeAny): boolean {
  // A defaulted field does not need to be supplied by the caller, so it must
  // not land in JSON Schema's `required[]` — otherwise every tool with `.default(...)`
  // looks mandatory to a strict validator (and, in practice, to every LLM).
  return type instanceof z.ZodOptional || type instanceof z.ZodDefault;
}
