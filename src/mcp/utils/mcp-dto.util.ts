import { plainToInstance } from "class-transformer";
import { ValidationError, validate } from "class-validator";
import { z } from "zod";
import { PipeTransform } from "@nestjs/common";
import { Payload, RpcException } from "@nestjs/microservices";
import { idDescription, ToolName } from "./mcp-tool-names";
import { businessDayRange, resolveQuickRange, TrendRange, uuidField } from "./mcp-date.util";

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


/**
 * Paging and sorting keys. They have defaults, so they are always present
 * and are never counted as "filters". Keep in sync with listPaging
 * (ideally export this list from the same file as listPaging and import it here).
 */
export const PAGING_KEYS = ["limit", "page", "sortBy", "sortOrder", "cursor"] as const;

const isPagingKey = (key: string): boolean =>
  (PAGING_KEYS as readonly string[]).includes(key);

/** A value counts as "set" unless it is empty (models sometimes send "" or [] for unused fields). */
export const isSet = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

/** `"all"` / empty means "no filter". */
export function omitAll<T>(value: T | "all" | undefined | null): T | undefined {
  if (!isSet(value) || value === "all") return undefined;
  return value as T;
}

export function omitAllList(values?: string[]): string[] | undefined {
  if (!values?.length) return undefined;
  const next = values.filter((v) => v && v !== "all");
  return next.length ? next : undefined;
}

/**
 * MCP date window: either `range` or start/end dates, never both.
 * Returns Cairo-inclusive instants (or nothing if neither was passed).
 */
export function resolveToolDates(q: {
  range?: string;
  startDate?: string;
  endDate?: string;
}): { startDate?: Date; endDate?: Date } {
  const hasRange = isSet(q.range);
  const hasStart = isSet(q.startDate);
  const hasEnd = isSet(q.endDate);
  if (hasRange && (hasStart || hasEnd)) {
    throw new RpcException("Pass either `range` or `startDate`/`endDate`, not both. Remove one.");
  }
  assertDateOrder(q as Record<string, unknown>);
  if (hasRange) {
    const { startDate, endDate } = resolveQuickRange(q.range as TrendRange);
    const { start, end } = businessDayRange(startDate, endDate);
    return { startDate: start, endDate: end };
  }
  const { start, end } = businessDayRange(
    hasStart ? q.startDate : undefined,
    hasEnd ? q.endDate : undefined,
  );
  return { startDate: start, endDate: end };
}

/**
 * Builds the input schema of a `*_search` tool.
 * - adds the optional `id` field (same description everywhere)
 * - throws at startup if a filter has a default (it would always look "set")
 */
export function searchInput<S extends z.ZodRawShape>(
  entity: string,
  shape: S,
  lookup: ToolName,
) {
  for (const [key, schema] of Object.entries(shape)) {
    if (!isPagingKey(key) && schema instanceof z.ZodDefault) {
      throw new Error(
        `${entity}_search: filter "${key}" must not have a default. ` +
          `It would always count as set and break fetching by id.`,
      );
    }
  }

  return z.strictObject({
    id: uuidField(
      idDescription(
        `${entity} ID. Pass it to get ONE ${entity} with full details. Omit it to search and list.`,
        lookup,
      ),
    ).optional(),
    ...shape,
  });
}

const DATE_PAIRS = [
  ["startDate", "endDate"],
  ["postponedStartDate", "postponedEndDate"],
  ["shippedStartDate", "shippedEndDate"],
] as const;

/** Rejects start > end on known date-range pairs. Call after Zod has already checked YYYY-MM-DD. */
export function assertDateOrder(q: Record<string, unknown>) {
  for (const [a, b] of DATE_PAIRS) {
    const start = q[a];
    const end = q[b];
    if (typeof start === "string" && typeof end === "string" && start > end) {
      throw new RpcException(`\`${a}\` (${start}) is after \`${b}\` (${end}). Swap them.`);
    }
  }
}

export type SearchRequest<Q> =
  | { mode: "get"; id: string }
  | { mode: "list"; query: Q };

/**
 * Splits the parsed input into "get one" or "list".
 * - no id        -> { mode: "list", query }  (query = everything except id)
 * - id, no filters -> { mode: "get", id }
 * - id + filters -> throws an actionable error
 */
export function parseSearchInput<I extends { id?: string }>(
  input: I,
  entity: string,
): SearchRequest<Omit<I, "id">> {
  const { id, ...query } = input;

  if (!id) {
    assertDateOrder(query as Record<string, unknown>);
    return { mode: "list", query };
  }

  const filters = Object.entries(query)
    .filter(([key, value]) => !isPagingKey(key) && isSet(value))
    .map(([key]) => key);

  if (filters.length > 0) {
    throw new RpcException(
      `Pass either \`id\` or filters, not both (got: ${filters.join(", ")}). ` +
        `Remove \`id\` to search, or remove the filters to fetch one ${entity}.`,
    );
  }

  return { mode: "get", id };
}

export type SaveRequest<F> =
  | { mode: "create"; fields: F }
  | { mode: "update"; id: string; fields: F };

/**
 * Splits a `*_save` payload. `mode` is required; never inferred from `id`.
 * `id` is forbidden on create and required on update.
 */
export function parseSaveInput<I extends { mode?: string; id?: string }>(
  input: I,
  entity: string,
  searchTool: string,
  opts?: { updateOnlyKeys?: string[] },
): SaveRequest<Omit<I, "mode" | "id">> {
  const { mode, id, ...fields } = input;

  if (mode !== "create" && mode !== "update") {
    throw new RpcException(
      `\`mode\` is required: "create" or "update". Do not infer it from \`id\`.`,
    );
  }

  if (mode === "create") {
    if (isSet(id)) {
      throw new RpcException(
        `mode=create forbids \`id\`. Omit \`id\` to create, or set mode=update to change an existing ${entity}. Find it with ${searchTool}.`,
      );
    }
    const extra = (opts?.updateOnlyKeys ?? []).filter((key) => isSet((fields as Record<string, unknown>)[key]));
    if (extra.length > 0) {
      throw new RpcException(
        `${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} update-only. Set mode=update and pass \`id\`, or remove ${extra.join(", ")}. Find the ${entity} with ${searchTool}.`,
      );
    }
    return { mode: "create", fields };
  }

  if (!id) {
    throw new RpcException(
      `mode=update requires \`id\`. Use ${searchTool} to find it.`,
    );
  }

  return { mode: "update", id, fields };
}