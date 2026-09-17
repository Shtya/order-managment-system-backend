export const OTEL_USER_ATTR = {
  id: "user.id",
  name: "user.name",
  adminId: "admin_id",
} as const;

export const OTEL_USER_BAGGAGE_KEYS = [
  OTEL_USER_ATTR.id,
  OTEL_USER_ATTR.name,
  OTEL_USER_ATTR.adminId,
] as const;
