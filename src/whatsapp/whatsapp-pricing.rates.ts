/**
 * Meta WhatsApp Cloud API per-message USD list rates (effective 1 July 2026).
 * Utility/authentication volume tiers are not applied (list rate).
 * Service messages use the utility rate when Meta marks them billable (`type: regular`).
 * Source: Meta rate card / published market rates.
 */
export type WhatsappRateBucket = {
  marketing: number;
  utility: number;
  authentication: number;
  authenticationInternational?: number;
};

const OTHER: WhatsappRateBucket = {
  marketing: 0.0604,
  utility: 0.0077,
  authentication: 0.0077,
};

const MARKETS: Record<string, WhatsappRateBucket> = {
  EG: { marketing: 0.0644, utility: 0.0036, authentication: 0.0036, authenticationInternational: 0.065 },
  IN: { marketing: 0.0118, utility: 0.0014, authentication: 0.0014, authenticationInternational: 0.0304 },
  BR: { marketing: 0.0625, utility: 0.0068, authentication: 0.0068 },
  ID: { marketing: 0.0411, utility: 0.025, authentication: 0.025, authenticationInternational: 0.136 },
  MX: { marketing: 0.0305, utility: 0.0085, authentication: 0.0085 },
  NG: { marketing: 0.0516, utility: 0.0067, authentication: 0.0067, authenticationInternational: 0.075 },
  PK: { marketing: 0.0473, utility: 0.01, authentication: 0.01, authenticationInternational: 0.075 },
  SA: { marketing: 0.0501, utility: 0.0107, authentication: 0.0107, authenticationInternational: 0.0598 },
  AE: { marketing: 0.0499, utility: 0.0157, authentication: 0.0157, authenticationInternational: 0.051 },
  ZA: { marketing: 0.0379, utility: 0.0076, authentication: 0.0076, authenticationInternational: 0.02 },
  GB: { marketing: 0.0635, utility: 0.022, authentication: 0.022 },
  NA: { marketing: 0.025, utility: 0.0034, authentication: 0.0034 },
  DE: { marketing: 0.1365, utility: 0.055, authentication: 0.055 },
  FR: { marketing: 0.0859, utility: 0.03, authentication: 0.03 },
  AFRICA: { marketing: 0.0225, utility: 0.004, authentication: 0.004 },
  APAC: { marketing: 0.0732, utility: 0.0113, authentication: 0.0113 },
  LATAM: { marketing: 0.074, utility: 0.0113, authentication: 0.0113 },
  MENA: { marketing: 0.0341, utility: 0.0091, authentication: 0.0091 },
  OTHER,
};

/** Longest-prefix calling codes → market key. */
const CALLING_CODES: Array<[string, string]> = [
  ["20", "EG"],
  ["27", "ZA"],
  ["234", "NG"],
  ["91", "IN"],
  ["92", "PK"],
  ["62", "ID"],
  ["55", "BR"],
  ["52", "MX"],
  ["966", "SA"],
  ["971", "AE"],
  ["44", "GB"],
  ["49", "DE"],
  ["33", "FR"],
  ["1", "NA"],
  ["212", "AFRICA"],
  ["213", "AFRICA"],
  ["216", "AFRICA"],
  ["218", "AFRICA"],
  ["221", "AFRICA"],
  ["225", "AFRICA"],
  ["233", "AFRICA"],
  ["249", "AFRICA"],
  ["251", "AFRICA"],
  ["254", "AFRICA"],
  ["255", "AFRICA"],
  ["256", "AFRICA"],
  ["237", "AFRICA"],
  ["90", "MENA"],
  ["962", "MENA"],
  ["963", "MENA"],
  ["964", "MENA"],
  ["965", "MENA"],
  ["968", "MENA"],
  ["973", "MENA"],
  ["974", "MENA"],
  ["961", "MENA"],
  ["970", "MENA"],
  ["972", "MENA"],
  ["60", "APAC"],
  ["63", "APAC"],
  ["66", "APAC"],
  ["84", "APAC"],
  ["81", "APAC"],
  ["82", "APAC"],
  ["86", "APAC"],
  ["61", "APAC"],
  ["64", "APAC"],
  ["65", "APAC"],
  ["852", "APAC"],
  ["886", "APAC"],
  ["880", "APAC"],
  ["94", "APAC"],
  ["95", "APAC"],
  ["977", "APAC"],
  ["54", "LATAM"],
  ["56", "LATAM"],
  ["57", "LATAM"],
  ["51", "LATAM"],
  ["58", "LATAM"],
  ["593", "LATAM"],
  ["502", "LATAM"],
  ["503", "LATAM"],
  ["504", "LATAM"],
  ["505", "LATAM"],
  ["506", "LATAM"],
  ["507", "LATAM"],
  ["34", "OTHER"],
  ["39", "OTHER"],
  ["31", "OTHER"],
  ["32", "OTHER"],
  ["46", "OTHER"],
  ["47", "OTHER"],
  ["48", "OTHER"],
  ["351", "OTHER"],
  ["30", "OTHER"],
  ["7", "OTHER"],
];

CALLING_CODES.sort((a, b) => b[0].length - a[0].length);

export function digitsPhone(phone?: string | null): string {
  return String(phone || "").replace(/\D/g, "");
}

export function marketForPhone(phone?: string | null): string {
  let digits = digitsPhone(phone);
  if (!digits) return "OTHER";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `20${digits.slice(1)}`;
  for (const [code, market] of CALLING_CODES) {
    if (digits.startsWith(code)) return market;
  }
  return "OTHER";
}

export function rateForCategory(
  market: string,
  category?: string | null,
): number {
  const bucket = MARKETS[market] || OTHER;
  const key = String(category || "")
    .toLowerCase()
    .replace(/_/g, "-");
  if (key === "authentication-international") {
    return bucket.authenticationInternational ?? bucket.authentication;
  }
  if (key === "authentication") return bucket.authentication;
  if (key === "utility" || key === "service") return bucket.utility;
  if (key === "marketing" || key === "marketing-lite" || key === "marketing_lite") {
    return bucket.marketing;
  }
  return bucket.marketing;
}

export function resolveWhatsappMessageCost(input: {
  pricing?: any;
  phone?: string | null;
}): { amount: number; currency: string; category: string | null; type: string | null } | null {
  const pricing = input.pricing;
  if (!pricing || typeof pricing !== "object") return null;

  const type = String(pricing.type || "").toLowerCase() || null;
  const category = String(pricing.category || "").toLowerCase() || null;
  const billable = pricing.billable;
  const isFreeType =
    type === "free_customer_service" ||
    type === "free_entry_point" ||
    category === "referral_conversion";
  const isRegular = type === "regular" || (!type && billable === true);

  if (isFreeType || billable === false) {
    return { amount: 0, currency: "USD", category, type: type || "free" };
  }

  const webhookAmount = Number(pricing.cost?.amount);
  const webhookCurrency = pricing.cost?.currency || "USD";
  if (Number.isFinite(webhookAmount) && webhookAmount >= 0 && pricing.cost) {
    return {
      amount: webhookAmount,
      currency: String(webhookCurrency).toUpperCase(),
      category,
      type: type || "regular",
    };
  }

  if (!isRegular) return null;

  const market = marketForPhone(input.phone);
  const amount = rateForCategory(market, category);
  return {
    amount,
    currency: "USD",
    category,
    type: type || "regular",
  };
}
