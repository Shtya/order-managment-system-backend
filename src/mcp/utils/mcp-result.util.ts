/**
 * MCP tool results are `{ content: [{ type: "text", text }] }`; a text block
 * can only hold a string, so objects must be serialized. These helpers build
 * that shape in one line.
 */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Everything in a result lands in the model's context. Keep it small. */
const DEFAULT_MAX_CHARS = 60_000;

// JSON.stringify throws on BigInt; send them as strings.
const replacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

export const toolText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

/** A failure the model can read and react to (sets isError). */
export const toolError = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

/**
 * Serialize any value as the tool result. If the JSON is too large it is NOT
 * cut (cut JSON is invalid): the model gets an error telling it to narrow down.
 */
export function toolJson(
  data: unknown,
  opts: { maxChars?: number } = {},
): ToolResult {
  const text = JSON.stringify(data, replacer);
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (text.length > max) {
    return toolError(
      `Result too large (${text.length} characters, limit ${max}). Ask for fewer items (smaller limit) or add filters.`,
    );
  }
  return toolText(text);
}

/** Shape your list services already return. */
export type PagedResult<T> = {
  records?: T[];
  total_records?: number;
  current_page?: number;
  per_page?: number;
};

/**
 * Paginated list result, e.g.
 *   return toolPage("orders", result, toOrderDto, limit);
 * -> { total_records, current_page, per_page, orders: [...] }
 */
export function toolPage<T, R>(
  key: string,
  result: PagedResult<T> | null | undefined,
  map: (row: T) => R,
  fallbackLimit: number,
): ToolResult {
  const records = Array.isArray(result?.records) ? result!.records! : [];
  return toolJson({
    total_records: result?.total_records ?? records.length,
    current_page: result?.current_page ?? 1,
    per_page: result?.per_page ?? fallbackLimit,
    [key]: records.map((row) => map(row)),
  });
}
