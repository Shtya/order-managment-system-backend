import { plainToInstance } from "class-transformer";
import { ValidationError, validate } from "class-validator";
import { z } from "zod";
import { PipeTransform } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";

type ParseResult<T> = { ok: true; dto: T } | { ok: false; message: string };

/** "items.0.qty: min, isInt" — property path + constraint NAMES, nested DTOs included. */
function flatten(errors: ValidationError[], parent = ""): string[] {
  return errors.flatMap((e) => {
    const path = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints
      ? [`${path}: ${Object.keys(e.constraints).join(", ")}`]
      : [];
    return [...own, ...flatten(e.children ?? [], path)];
  });
}

/**
 * Tools call services directly, so the HTTP ValidationPipe never runs.
 * This runs the SAME class-validator rules your REST endpoints use.
 *
 * Mirror the options of your global ValidationPipe here (whitelist, transform...)
 * so REST and MCP behave the same.
 *
 * Why constraint names and not messages: your DTOs use i18nValidationMessage,
 * whose raw output is a translation key ("validation.max_length|{...}"), not
 * text a model can read.
 */
export async function parseDto<T extends object>(
  cls: new () => T,
  input: unknown,
): Promise<ParseResult<T>> {
  const dto = plainToInstance(cls, input);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true, // a Zod field missing from the DTO = dev bug: fail loudly
  });
  if (errors.length === 0) return { ok: true, dto };
  return { ok: false, message: `Invalid input. ${flatten(errors).join("; ")}` };
}

/**
 * MCP convention: input problems are returned as a tool RESULT with isError,
 * so the model can read the message, fix its arguments and retry.
 */
export const toolError = (text: string) => ({
  isError: true,
  content: [{ type: "text" as const, text }],
});

type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Compile-time guard against Zod/DTO drift. Wrap a tool's Zod schema:
 *
 *   const input = toolInputFor<CreateOrderDto>()(z.object({ ... }));
 *
 * It fails to compile when the schema
 *   - is missing a field that is REQUIRED in the DTO,
 *   - uses a different type for a field, or
 *   - still uses a field name that was renamed in the DTO.
 * Fields that are optional in the DTO may be left out on purpose.
 * (A field that exists only in Zod is caught at runtime by parseDto.)
 */
export const toolInputFor =
  <D extends object>() =>
  <S extends z.ZodType<Pick<D, RequiredKeys<D>> & Partial<D>>>(schema: S): S =>
    schema;

/**
 * Shared page / limit / sortBy / sortOrder / search fields for every list tool.
 *
 *   ...listPaging({
 *     items: "stores",
 *     sortBy: ["created_at", "name"],
 *     search: "Matches store name or store URL",
 *   })
 *
 * `search` is included by default. Pass a string to set its description, or
 * `search: false` to omit the field.
 */
type ListPagingOpts<T extends readonly [string, ...string[]]> = {
  items: string;
  sortBy: T;
  defaultSortBy?: T[number];
};

function listPagingFields<const T extends readonly [string, ...string[]]>(
  opts: ListPagingOpts<T>,
) {
  const defaultSortBy = (opts.defaultSortBy ?? opts.sortBy[0]) as T[number];
  return {
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Page number, starting at 1"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(`The number of ${opts.items} to return`),
    sortBy: z
      .enum(opts.sortBy)
      .default(defaultSortBy as never)
      .describe(`Field to sort by. One of: ${opts.sortBy.join(", ")}.`),
    sortOrder: z
      .enum(["ASC", "DESC"])
      .default("DESC")
      .describe("Sort direction"),
  };
}

export function listPaging<const T extends readonly [string, ...string[]]>(
  opts: ListPagingOpts<T> & { search: false },
): ReturnType<typeof listPagingFields<T>>;
export function listPaging<const T extends readonly [string, ...string[]]>(
  opts: ListPagingOpts<T> & { search?: string },
): ReturnType<typeof listPagingFields<T>> & {
  search: z.ZodOptional<z.ZodString>;
};
export function listPaging<const T extends readonly [string, ...string[]]>(
  opts: ListPagingOpts<T> & { search?: string | false },
) {
  const paging = listPagingFields(opts);
  if (opts.search === false) return paging;
  return {
    ...paging,
    search: z
      .string()
      .optional()
      .describe(opts.search ?? `Search ${opts.items}`),
  };
}

  /**
 * Runs parseDto (class-validator) on the tool payload and hands the handler a
 * real, validated DTO instance. Invalid input throws an RpcException whose
 * message lists the failing fields, e.g. "Invalid input. items.0.quantity: min".
 */
class DtoPayloadPipe<T extends object> implements PipeTransform {
  constructor(private readonly cls: new () => T) {}

  async transform(value: unknown): Promise<T> {
    const parsed = await parseDto(this.cls, value);
    if (parsed.ok === false) throw new RpcException(parsed.message);
    return parsed.dto;
  }
}

/**
 * Use instead of `@Payload()` + `parseDto(...)`:
 *
 *   async createOrder(@McpDto(CreateOrderDto) dto: CreateOrderDto, @McpUser() user: User)
 *
 * The parameter type is written by hand (decorators can't change it), so keep
 * it equal to the class you pass in.
 */
export const McpDto = <T extends object>(cls: new () => T): ParameterDecorator =>
  Payload(new DtoPayloadPipe(cls));