import { EMAIL_DEFAULT_STYLE } from "./email-content.defaults";

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

export function resolveEmailBlockStyle(
  defaults: Record<string, unknown> = {},
  blockStyle: Record<string, unknown> = {},
) {
  return { ...EMAIL_DEFAULT_STYLE, ...defaults, ...blockStyle };
}

export function emailBoxCss(style: Record<string, any> = {}) {
  const sides = (name: string) =>
    SIDES.filter((side) => style[`${name}${side}`] !== undefined).map(
      (side) => `${name}-${side.toLowerCase()}:${style[`${name}${side}`]}px`,
    );
  return [
    style.backgroundColor
      ? `background-color:${style.backgroundColor}`
      : null,
    style.borderWidth
      ? `border:${style.borderWidth}px solid ${style.borderColor || "#222222"}`
      : null,
    style.borderRadius !== undefined
      ? `border-radius:${style.borderRadius}px`
      : null,
    style.padding !== undefined ? `padding:${style.padding}px` : null,
    ...sides("padding"),
  ]
    .filter(Boolean)
    .join(";");
}

export function emailOuterPadding(
  style: Record<string, any> = {},
  legacy?: number,
) {
  const value = style.margin ?? legacy ?? 0;
  return [
    `padding="${value}px"`,
    ...SIDES.filter((side) => style[`margin${side}`] !== undefined).map(
      (side) =>
        `padding-${side.toLowerCase()}="${style[`margin${side}`]}px"`,
    ),
  ].join(" ");
}
