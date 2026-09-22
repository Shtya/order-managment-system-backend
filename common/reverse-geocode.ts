import { BadRequestException } from "@nestjs/common";

export type ReverseGeocodeResult = {
  provider: "mapbox" | "nominatim";
  displayName: string | null;
  composedAddress: string | null;
  isSparse: boolean;
  hasStreetLevelDetail: boolean;
  detailNote: string | null;
  latitude: number;
  longitude: number;
  country: string | null;
  countryCode: string | null;
  state: string | null;
  city: string | null;
  district: string | null;
  postcode: string | null;
  road: string | null;
  houseNumber: string | null;
  landmark: string | null;
  rawAddress: unknown;
};

/** Mapbox Search Box first, then OpenStreetMap Nominatim. */
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<ReverseGeocodeResult> {
  const fromMapbox = await reverseGeocodeMapbox(lat, lon);
  if (fromMapbox) return fromMapbox;
  return reverseGeocodeNominatim(lat, lon);
}

/** Street from Search Box reverse, plus the nearest nearby place as a landmark. */
export async function reverseGeocodeMapbox(
  lat: number,
  lon: number,
): Promise<ReverseGeocodeResult | null> {
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token) return null;

  try {
    const [streetFeatures, poiFeatures] = await Promise.all([
      fetchMapboxReverse(lat, lon, "street", 1, token),
      fetchMapboxReverse(lat, lon, "poi", 5, token),
    ]);

    const feature = streetFeatures[0];
    if (!feature) return null;

    const landmark = nearestMapboxLandmark(poiFeatures, lat, lon);
    const mapped = mapMapboxReverseFeature(feature, lat, lon, landmark);
    if (!mapped.composedAddress) return null;
    console.log("mapped", JSON.stringify(mapped, null, 2));
    return mapped;
  } catch {
    return null;
  }
}

async function fetchMapboxReverse(
  lat: number,
  lon: number,
  types: string,
  limit: number,
  token: string,
): Promise<any[]> {
  const url =
    `https://api.mapbox.com/search/searchbox/v1/reverse` +
    `?longitude=${encodeURIComponent(String(lon))}` +
    `&latitude=${encodeURIComponent(String(lat))}` +
    `&language=ar` +
    `&types=${encodeURIComponent(types)}` +
    `&limit=${limit}` +
    `&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  }).catch(() => null);
  if (!res?.ok) return [];

  const data = await res.json();
  return Array.isArray(data?.features) ? data.features : [];
}

function nearestMapboxLandmark(
  features: any[],
  lat: number,
  lon: number,
): string | null {
  let nearestName: string | null = null;
  let nearestDistance = Infinity;

  for (const feature of features) {
    const properties = feature?.properties || {};
    const name = textOrNull(properties.name);
    if (!name) continue;

    const coordinates = properties.coordinates || {};
    const point = feature?.geometry?.coordinates;
    const placeLat = numberOrNull(coordinates.latitude) ?? numberOrNull(point?.[1]);
    const placeLon = numberOrNull(coordinates.longitude) ?? numberOrNull(point?.[0]);
    if (placeLat === null || placeLon === null) continue;

    const distance = haversineMeters(lat, lon, placeLat, placeLon);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestName = name;
    }
  }

  if (!nearestName || nearestDistance > 100) return null;
  return nearestName;
}

export async function reverseGeocodeNominatim(
  lat: number,
  lon: number,
): Promise<ReverseGeocodeResult> {
  const lang = "ar";
  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?format=json` +
    `&lat=${lat}` +
    `&lon=${lon}` +
    `&accept-language=${encodeURIComponent(lang)}` +
    `&addressdetails=1` +
    `&zoom=18`;

  let res: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, attempt * 1000),
      );
    }

    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Language": lang,
          "User-Agent": "Madar/1.0 (https://getmadar.net)",
        },
      });

      if (res.ok) {
        break;
      }

      const errorBody = await res.text();
      lastError = new Error(
        `Nominatim HTTP error: status=${res.status}, ` +
        `statusText="${res.statusText}", ` +
        `body="${errorBody}"`,
      );

      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw lastError;
      }

      if (attempt === 3) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;

      if (attempt === 3) {
        throw new BadRequestException(
          `Reverse geocoding failed after ${attempt + 1} attempts: ${error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (!res?.ok) {
    throw new BadRequestException(
      `Reverse geocoding failed: ${lastError instanceof Error
        ? lastError.message
        : String(lastError)
      }`,
    );
  }

  let data: any;
  try {
    data = await res.json();
  } catch (error) {
    throw new BadRequestException(
      `Nominatim returned an invalid JSON response: ${error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const addr = data.address || {};
  const city =
    addr.city ||
    addr.town ||
    addr.village ||
    addr.municipality ||
    addr.county ||
    null;
  const district =
    addr.suburb ||
    addr.neighbourhood ||
    addr.quarter ||
    addr.city_district ||
    null;
  const road = addr.road || addr.pedestrian || addr.path || null;
  const houseNumber = addr.house_number || null;
  const state = addr.state || addr.region || null;
  const country = addr.country || null;
  const displayName = data.display_name || null;

  const detailParts = [
    [houseNumber, road].filter(Boolean).join(" "),
    district,
    city,
    state,
    country,
  ]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);

  const composedAddress = detailParts.join("، ") || displayName;
  const hasStreetLevelDetail = !!(road || houseNumber || district);
  const isSparse =
    !hasStreetLevelDetail &&
    !!city &&
    detailParts.length <= 3;

  const mapped = {
    provider: "nominatim" as const,
    displayName,
    composedAddress,
    isSparse,
    hasStreetLevelDetail,
    detailNote: isSparse
      ? "Reverse geocode is city/governorate level only (no street in map data). Do not treat this short result as a complete address."
      : null,
    latitude: lat,
    longitude: lon,
    country,
    countryCode: addr.country_code || null,
    state,
    city,
    district,
    postcode: addr.postcode || null,
    road,
    houseNumber,
    landmark: null,
    rawAddress: addr,
  };
  console.log("mapped", JSON.stringify(mapped, null, 2));
  return mapped;
}

function mapMapboxReverseFeature(
  feature: any,
  lat: number,
  lon: number,
  landmark: string | null,
): ReverseGeocodeResult {
  const properties = feature?.properties || {};
  const context = properties.context || {};
  const street = textOrNull(context.street?.name);
  const neighborhood = textOrNull(context.neighborhood?.name);
  const locality = textOrNull(context.locality?.name);
  const place = textOrNull(context.place?.name);
  const region = textOrNull(context.region?.name);
  const country = textOrNull(context.country?.name);
  const postcode = textOrNull(context.postcode?.name);
  const houseNumber = textOrNull(
    context.address?.address_number || context.address?.name,
  );

  const district = neighborhood || locality || place;
  const city = place;
  const road = street || textOrNull(properties.name);
  const streetLine = [houseNumber, road].filter(Boolean).join(" ");
  const landmarkText = landmark ? `بجوار ${landmark}` : null;
  // Postcode stays in its own field. Mapbox often returns a short code such as
  // "45" here, and that is not a building number.
  const composedAddress = uniqueParts([
    streetLine,
    landmarkText,
    neighborhood,
    locality,
    place,
    region,
    country,
  ]).join("، ");

  const hasStreetLevelDetail = !!(road || houseNumber);
  const isSparse =
    !(road || houseNumber || district) &&
    !!region &&
    uniqueParts([district, region, country]).length <= 2;

  return {
    provider: "mapbox",
    displayName: composedAddress || textOrNull(properties.full_address),
    composedAddress: composedAddress || null,
    isSparse,
    hasStreetLevelDetail,
    detailNote: isSparse
      ? "Reverse geocode has no street. Do not treat this short result as a complete address."
      : null,
    latitude: lat,
    longitude: lon,
    country,
    countryCode: textOrNull(context.country?.country_code),
    state: region,
    city,
    district,
    postcode,
    road,
    houseNumber,
    landmark,
    rawAddress: context,
  };
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const earthRadius = 6371000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latDelta = toRadians(lat2 - lat1);
  const lonDelta = toRadians(lon2 - lon1);
  const startLat = toRadians(lat1);
  const endLat = toRadians(lat2);
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(lonDelta / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function uniqueParts(parts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const text = (part || "").trim();
    if (!text) continue;
    if (out.some((existing) => existing === text)) continue;
    out.push(text);
  }
  return out;
}
