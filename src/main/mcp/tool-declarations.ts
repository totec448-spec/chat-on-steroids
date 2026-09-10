import { z } from 'zod';

/** Only declarations are shared. Each registration still supplies its own live handler. */
const declarations = new Map<string, { key: string; value: object }>();

export function toolDeclaration<T extends object>(name: string, create: () => T, key = ''): T {
  const previous = declarations.get(name);
  if (previous?.key === key) return previous.value as T;
  const value = Object.freeze(create());
  // One current entry per tool: editing roots must not accumulate old declarations.
  declarations.set(name, { key, value });
  return value;
}

function convertSchema(schema: z.ZodType, io: 'input' | 'output') {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io });
}
type JsonSchema = ReturnType<typeof convertSchema>;
const schemas = new WeakMap<z.ZodType, Partial<Record<'input' | 'output', JsonSchema>>>();

/** The publication observer and the SDK use the same conversion target and cached value. */
export function toolSchemaJson(schema: z.ZodType, io: 'input' | 'output' = 'input'): JsonSchema {
  let converted = schemas.get(schema);
  if (!converted) schemas.set(schema, converted = {});
  return converted[io] ??= convertSchema(schema, io);
}

const adapters = new WeakMap<z.ZodType, ReturnType<typeof createAdapter>>();
function createAdapter(schema: z.ZodType) {
  const standard = schema['~standard'];
  return {
    '~standard': {
      ...standard,
      // Forward the original validator, including transforms and refinements. JSON Schema
      // is only the published description, never a replacement validation authority.
      jsonSchema: {
        input: (options: { target: string }) => options.target === 'draft-2020-12'
          ? toolSchemaJson(schema, 'input') : standard.jsonSchema.input(options),
        output: (options: { target: string }) => options.target === 'draft-2020-12'
          ? toolSchemaJson(schema, 'output') : standard.jsonSchema.output(options)
      }
    }
  };
}

/** Supported Standard Schema adapter; no shared SDK instance or private SDK state. */
export function toolSchema(schema: z.ZodType): ReturnType<typeof createAdapter> {
  let adapter = adapters.get(schema);
  if (!adapter) adapters.set(schema, adapter = createAdapter(schema));
  return adapter;
}
