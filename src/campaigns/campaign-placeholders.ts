export type CampaignPlaceholderContext = {
  name?: string | null;
  phoneNumber?: string | null;
  orderToken?: string | null;
  orderUrl?: string | null;
};

function rawText(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "object" && !Array.isArray(input) && "value" in (input as object)) {
    return String((input as { value?: unknown }).value ?? "");
  }
  return String(input);
}

function placeholderValue(
  ctx: CampaignPlaceholderContext,
  kind: "name" | "number",
): string {
  if (kind === "name") {
    const name = String(ctx.name ?? "").trim();
    if (name) return name;
    const phone = String(ctx.phoneNumber ?? "").trim();
    return phone || "-";
  }
  return String(ctx.phoneNumber ?? "").trim() || "-";
}

export function hydrateCampaignPlaceholders(
  input: unknown,
  ctx: CampaignPlaceholderContext,
): string {
  const tokenRe =
    /\{\{\s*(customer\.(?:name|number)|campaign\.(?:orderToken|orderUrl))\s*\}\}/gi;
  return rawText(input).replace(tokenRe, (_m, id: string) => {
    const key = String(id).toLowerCase();
    if (key === "customer.name") return placeholderValue(ctx, "name");
    if (key === "customer.number") return placeholderValue(ctx, "number");
    if (key === "campaign.ordertoken") return String(ctx.orderToken ?? "").trim() || "-";
    if (key === "campaign.orderurl") return String(ctx.orderUrl ?? "").trim() || "-";
    return "-";
  });
}

export function hydrateCampaignVariableMap(
  vars: Record<string, any> | undefined | null,
  ctx: CampaignPlaceholderContext,
): Record<string, any> | undefined {
  if (!vars || typeof vars !== "object") return vars ?? undefined;
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(vars)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      out[key] = {
        ...val,
        value: hydrateCampaignPlaceholders(val.value ?? "", ctx),
      };
    } else {
      out[key] = hydrateCampaignPlaceholders(val, ctx);
    }
  }
  return out;
}

export type CampaignLocationData = {
  latitude: string;
  longitude: string;
  address: string;
  name: string;
};

export function hydrateCampaignLocationData(
  locationData: Record<string, any> | undefined | null,
  ctx: CampaignPlaceholderContext,
): CampaignLocationData | undefined {
  if (!locationData || typeof locationData !== "object") return undefined;
  return {
    latitude: String(locationData.latitude ?? ""),
    longitude: String(locationData.longitude ?? ""),
    name: hydrateCampaignPlaceholders(locationData.name ?? "", ctx),
    address: hydrateCampaignPlaceholders(locationData.address ?? "", ctx),
  };
}
