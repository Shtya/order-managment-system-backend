export const EMAIL_ALLOWED_FONTS = Object.freeze([
  "Arial",
  "Verdana",
  "Tahoma",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Cairo",
  "Tajawal",
  "Noto Kufi Arabic",
  "Almarai",
]);

export const EMAIL_DEFAULT_STYLE = Object.freeze({
  fontFamily: "Cairo",
  fontSize: 16,
  color: "#222222",
  padding: 0,
});

export const EMAIL_STYLE_RULES = Object.freeze({
  color: /^#[0-9a-f]{6}$/i,
  backgroundColor: /^#[0-9a-f]{6}$/i,
  borderColor: /^#[0-9a-f]{6}$/i,
  fontFamily: new RegExp(
    `^(${EMAIL_ALLOWED_FONTS.map((font) => font.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
  ),
  fontSize: [8, 72],
  fontWeight: [100, 900],
  lineHeight: [1, 3],
  letterSpacing: [0, 10],
  paragraphSpacing: [0, 80],
  indent: [0, 100],
  padding: [0, 100],
  paddingTop: [0, 100],
  paddingBottom: [0, 100],
  paddingLeft: [0, 100],
  paddingRight: [0, 100],
  margin: [0, 100],
  marginTop: [0, 100],
  marginBottom: [0, 100],
  marginLeft: [0, 100],
  marginRight: [0, 100],
  spacing: [0, 100],
  width: [1, 1600],
  minHeight: [0, 300],
  borderWidth: [0, 10],
  borderRadius: [0, 100],
  align: /^(left|center|right|justify)$/,
});

export const EMAIL_FONT_FAMILY_PATTERN = EMAIL_STYLE_RULES.fontFamily;

export function isAllowedFontFamily(value: unknown): value is string {
  return typeof value === "string" && EMAIL_FONT_FAMILY_PATTERN.test(value);
}

export function normalizeEmailDefaults(defaults: Record<string, unknown> = {}) {
  return { ...EMAIL_DEFAULT_STYLE, ...defaults };
}
