/**
 * Maps UI / persisted validity keys to Meta `message_send_ttl_seconds`.
 * @see https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 */
export const VALIDITY_PERIOD_TO_SECONDS: Record<string, number> = {
  "30s": 30,
  "1m": 60,
  "2m": 120,
  "3m": 180,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "3h": 10800,
  "6h": 21600,
  "12h": 43200,
};

export function validityPeriodToSeconds(period?: string | null): number | undefined {
  if (!period || typeof period !== "string") return undefined;
  return VALIDITY_PERIOD_TO_SECONDS[period];
}

export function messageSendTtlSecondsFromConfig(cfg: {
  useCustomValidity?: boolean;
  validityPeriod?: string;
}): number | undefined {
  if (!cfg?.useCustomValidity) return undefined;
  const sec = validityPeriodToSeconds(cfg.validityPeriod);
  return sec != null && sec > 0 ? sec : undefined;
}

/** DB may store `call_permissions_request`; Meta uses a normal sub_category + CALL_PERMISSION_REQUEST component. */
export function isCallPermissionDbSubcategory(sub?: string | null): boolean {
  return String(sub || "").toLowerCase() === "call_permissions_request";
}

export function metaSubCategoryForPayload(
  category: string,
  dbSubCategory: string | undefined,
): string | undefined {
  const cat = String(category || "").toUpperCase();
  const sub = String(dbSubCategory || "").toLowerCase();

  if (isCallPermissionDbSubcategory(sub)) {
    return cat === "UTILITY" ? "order_details" : "order_details";
  }

  if (cat === "AUTHENTICATION") {
    return undefined;
  }

  return dbSubCategory;
}

export function defaultOtpCopyButtonText(): string {
  return "Copy code";
}
