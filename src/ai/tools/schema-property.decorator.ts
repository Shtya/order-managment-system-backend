import "reflect-metadata";

export const SCHEMA_PROPERTY_META_KEY = "ai:schema-property";

export interface SchemaPropertyMeta {
  description?: string;
  example?: unknown;
  examples?: unknown[];
  pattern?: string;
  format?: string;
}

export function SchemaProperty(meta: SchemaPropertyMeta): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const key = String(propertyKey);
    const existing =
      Reflect.getMetadata(SCHEMA_PROPERTY_META_KEY, target, key) ?? {};
    Reflect.defineMetadata(
      SCHEMA_PROPERTY_META_KEY,
      { ...existing, ...meta },
      target,
      key,
    );
  };
}

export function getSchemaPropertyMeta(
  target: object,
  propertyKey: string,
): SchemaPropertyMeta | undefined {
  return Reflect.getMetadata(SCHEMA_PROPERTY_META_KEY, target, propertyKey);
}
