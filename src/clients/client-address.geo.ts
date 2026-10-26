export const CLIENT_ADDRESS_GEO_PROVIDERS = ["bosta", "turbo"] as const;

export type ClientAddressGeoProvider =
  (typeof CLIENT_ADDRESS_GEO_PROVIDERS)[number];

export type ClientAddressShippingMetadata = {
  cityId?: string;
  zoneId?: string;
  districtId?: string;
  locationId?: string;
};

export function normalizeClientAddressProvider(
  value?: string | null,
): string | null {
  const code = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!code || code === "none") return null;
  return code;
}

export function isClientAddressGeoProvider(
  value?: string | null,
): value is ClientAddressGeoProvider {
  const code = normalizeClientAddressProvider(value);
  return code === "bosta" || code === "turbo";
}

export function sanitizeClientAddressShippingMetadata(
  meta?: ClientAddressShippingMetadata | null,
): ClientAddressShippingMetadata | null {
  if (!meta) return null;
  const out: ClientAddressShippingMetadata = {};
  for (const key of ["cityId", "zoneId", "districtId", "locationId"] as const) {
    const value = String(meta[key] ?? "").trim();
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function clientAddressGeoMissingField(
  provider: string | null,
  metadata: ClientAddressShippingMetadata | null,
): "providerCityId" | "zoneId" | "districtId" | null {
  if (!isClientAddressGeoProvider(provider)) return null;
  if (!metadata?.cityId) return "providerCityId";
  if (provider === "bosta" && !metadata.districtId) return "districtId";
  if (provider === "turbo" && !metadata.zoneId) return "zoneId";
  return null;
}
