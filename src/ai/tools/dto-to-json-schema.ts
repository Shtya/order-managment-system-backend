import { getMetadataStorage } from "class-validator";
import "reflect-metadata";
import { getSchemaPropertyMeta } from "./schema-property.decorator";
import { BadRequestException } from "@nestjs/common";

export interface JsonSchemaOptions {
  schemaDerivationTimeoutMs?: number;
}

type JsonSchemaType =
  "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  example?: unknown;
  examples?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

type ValidationRuleMeta = {
  propertyName?: string;
  name?: string;
  type: string;
  constraints?: unknown[];
};

function ruleKey(meta: ValidationRuleMeta): string {
  return meta.name ?? meta.type;
}

const PRIMITIVES = new Map<unknown, JsonSchemaType>([
  [String, "string"],
  [Number, "number"],
  [Boolean, "boolean"],
  [Object, "object"],
  [Array, "array"],
]);

/**
 * Derives a JSON Schema (draft-07-ish) from a class-validator DTO class.
 * Uses class-validator's metadata storage + reflect-metadata design:type.
 */
export function dtoToJsonSchema(
  DtoClass: new (...args: any[]) => object,
  options?: JsonSchemaOptions,
): Record<string, unknown> {
  const timeoutMs = options?.schemaDerivationTimeoutMs ?? 2000;
  const start = Date.now();

  const schema = deriveForClass(DtoClass, new Set<string>());

  if (Date.now() - start > timeoutMs) {
    throw new BadRequestException(
      `Schema derivation for '${DtoClass.name}' exceeded timeout (${timeoutMs}ms)`,
    );
  }

  return schema as unknown as Record<string, unknown>;
}

function deriveForClass(
  DtoClass: new (...args: any[]) => object,
  seen: Set<string>,
): JsonSchema {
  const className = DtoClass.name;
  const schema: JsonSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  if (seen.has(className)) return { type: "object" };
  seen.add(className);

  const metadataStorage = getMetadataStorage();
  const validationMetadatas: ValidationRuleMeta[] =
    metadataStorage.getTargetValidationMetadatas(
      DtoClass,
      DtoClass.name,
      true,
      false,
    ) as unknown as ValidationRuleMeta[];

  const byProperty = new Map<string, ValidationRuleMeta[]>();
  for (const meta of validationMetadatas) {
    if (!meta.propertyName) continue;
    const list = byProperty.get(meta.propertyName) ?? [];
    list.push(meta);
    byProperty.set(meta.propertyName, list);
  }

  const optionalProps = new Set<string>();
  for (const metas of byProperty.values()) {
    for (const meta of metas) {
      if (ruleKey(meta) === "isOptional") optionalProps.add(meta.propertyName);
    }
  }

  for (const [propertyName, metas] of byProperty.entries()) {
    const propertySchema = deriveProperty(DtoClass, propertyName, metas, seen);
    if (propertySchema) {
      schema.properties![propertyName] = propertySchema;
    }
  }

  const required = Array.from(byProperty.keys()).filter(
    (p) => !optionalProps.has(p),
  );
  if (required.length) schema.required = required;

  return schema;
}

function deriveProperty(
  DtoClass: new (...args: any[]) => object,
  propertyName: string,
  metas: ValidationRuleMeta[],
  seen: Set<string>,
): JsonSchema | undefined {
  const designType = Reflect.getMetadata(
    "design:type",
    DtoClass.prototype,
    propertyName,
  );
  const types = new Set<string>();
  const schema: JsonSchema = {};

  let enumValues: unknown[] | undefined;
  let nestedClass: any;
  let isArray = false;

  for (const meta of metas) {
    const t = ruleKey(meta);
    const constraint = meta.constraints?.[0];

    switch (t) {
      case "isString":
      case "isEmail":
      case "isUrl":
      case "isUUID":
      case "isPhoneNumber":
        types.add("string");
        break;
      case "isEnum":
      case "isIn":
        types.add("string");
        enumValues =
          t === "isEnum"
            ? extractEnumValues(constraint)
            : Array.isArray(meta.constraints?.[0])
              ? (meta.constraints![0] as unknown[])
              : undefined;
        break;
      case "isNumber":
      case "isInt":
        types.add("number");
        break;
      case "isBoolean":
        types.add("boolean");
        break;
      case "isArray":
        isArray = true;
        types.add("array");
        break;
      case "isObject":
      case "isInstance":
        types.add("object");
        break;
      case "nestedValidation":
        nestedClass = constraint;
        break;
      case "isOptional":
      case "isNotEmpty":
        break;
      default:
        if (t.startsWith("is")) types.add("string");
        break;
    }

    applyConstraint(schema, t, meta.constraints);
  }

  if (types.size === 0) {
    if (designType === Array) {
      isArray = true;
      types.add("array");
    } else if (designType && PRIMITIVES.has(designType)) {
      types.add(PRIMITIVES.get(designType)!);
    } else if (
      designType &&
      typeof designType === "function" &&
      designType !== Object
    ) {
      types.add("object");
      nestedClass = nestedClass ?? designType;
    } else {
      types.add("string");
    }
  }

  if (isArray) {
    const itemSchema: JsonSchema = {};
    if (nestedClass && typeof nestedClass === "function") {
      const nested = deriveForClass(nestedClass, seen);
      itemSchema.type = "object";
      itemSchema.properties = nested.properties;
      itemSchema.required = nested.required;
      itemSchema.additionalProperties = nested.additionalProperties;
    } else if (types.has("string")) {
      itemSchema.type = "string";
    } else if (types.has("number")) {
      itemSchema.type = "number";
    } else if (types.has("boolean")) {
      itemSchema.type = "boolean";
    } else {
      itemSchema.type = "object";
    }
    schema.type = "array";
    schema.items = itemSchema;
  } else if (
    nestedClass &&
    typeof nestedClass === "function" &&
    (types.has("object") || designType !== Object)
  ) {
    const nested = deriveForClass(nestedClass, seen);
    schema.type = "object";
    schema.properties = nested.properties;
    schema.required = nested.required;
    schema.additionalProperties = false;
  } else {
    const primaryType = types.has("string")
      ? "string"
      : types.has("number")
        ? "number"
        : types.has("boolean")
          ? "boolean"
          : "object";
    schema.type = primaryType;
    if (enumValues?.length) schema.enum = enumValues;
  }

  const schemaMeta = getSchemaPropertyMeta(DtoClass.prototype, propertyName);
  if (schemaMeta) {
    if (schemaMeta.description !== undefined) {
      schema.description = schemaMeta.description;
    }
    if (schemaMeta.example !== undefined) schema.example = schemaMeta.example;
    if (schemaMeta.examples !== undefined) {
      schema.examples = schemaMeta.examples;
    }
    if (schemaMeta.pattern !== undefined) schema.pattern = schemaMeta.pattern;
    if (schemaMeta.format !== undefined) schema.format = schemaMeta.format;
  }

  return Object.keys(schema).length ? schema : undefined;
}

function applyConstraint(
  schema: JsonSchema,
  type: string,
  constraints: unknown[],
) {
  const c0 = constraints?.[0];
  const c1 = constraints?.[1];

  switch (type) {
    case "min":
      schema.minimum = Number(c0);
      break;
    case "max":
      schema.maximum = Number(c0);
      break;
    case "minLength":
      schema.minLength = Number(c0);
      break;
    case "maxLength":
      schema.maxLength = Number(c0);
      break;
    case "length":
      schema.minLength = Number(c0);
      schema.maxLength = Number(c1);
      break;
    case "matches":
      if (c0 instanceof RegExp) schema.pattern = c0.source;
      else if (typeof c0 === "string") schema.pattern = c0;
      break;
    case "isEmail":
      schema.format = "email";
      break;
    case "isUrl":
      schema.format = "uri";
      break;
    case "isUUID":
      schema.format = "uuid";
      break;
    case "isPhoneNumber":
      schema.format = "phone";
      break;
  }
}

function extractEnumValues(constraint: unknown): unknown[] | undefined {
  if (constraint && typeof constraint === "object") {
    const values = Object.values(constraint as Record<string, unknown>);
    return values.length ? values : undefined;
  }
  if (Array.isArray(constraint)) return constraint;
  return undefined;
}
