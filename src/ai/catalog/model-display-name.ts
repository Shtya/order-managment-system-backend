/**
 * Display names are derived from the API model id only.
 *
 * Provider-specific overrides (custom labels) can be added later here.
 * Do not implement them yet — keep this file a pure id pretty-printer.
 */
export function displayNameFromModelId(modelCode: string): string {
  const id = String(modelCode || "").trim();
  if (!id) return id;

  const withoutDate = id.replace(/[-_]\d{4}-\d{2}-\d{2}$/i, "");
  const parts = withoutDate
    .split(/[-_/]+/)
    .filter(Boolean);

  return parts
    .map((part) => {
      if (/^\d/.test(part) || part.length <= 3) {
        return part.toUpperCase();
      }

      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}