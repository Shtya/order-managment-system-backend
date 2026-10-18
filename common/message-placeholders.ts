/** Shared vocabulary for campaign channels and reusable message rendering. */
export const MESSAGE_PLACEHOLDER_KEYS = [
  "customer.name",
  "customer.number",
  "customer.email",
  "campaign.orderUrl",
  "campaign.orderToken",
] as const;

export function messagePlaceholderPattern() {
  return new RegExp(
    "\\{\\{\\s*(" +
      MESSAGE_PLACEHOLDER_KEYS.map((key) => key.replace(/\./g, "\\.")).join(
        "|",
      ) +
      ")\\s*\\}\\}",
    "gi",
  );
}
