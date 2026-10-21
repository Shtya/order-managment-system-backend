import { EMAIL_ALLOWED_FONTS } from "./email-content.defaults";

/** Shared structural checks for the canonical v2 tree. No editor HTML is trusted. */
export const STYLE_RULES: Record<string, RegExp | [number, number]> = {
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
  height: [1, 1600],
  objectFit: /^(contain|cover|fill)$/,
  minHeight: [0, 300],
  borderWidth: [0, 10],
  borderRadius: [0, 100],
  align: /^(left|center|right|justify)$/,
};
export function validateEmailStyle(style: any) {
  if (!style || typeof style !== "object" || Array.isArray(style))
    throw new Error("style");
  for (const [key, value] of Object.entries(style)) {
    const rule = STYLE_RULES[key];
    if (
      !rule ||
      (rule instanceof RegExp
        ? typeof value !== "string" || !rule.test(value)
        : typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < rule[0] ||
          value > rule[1])
    )
      throw new Error("style:" + key);
  }
}
export function emailNodes(document: any): any[] {
  const result: any[] = [];
  const walk = (nodes: any[], depth: number) => {
    if (!Array.isArray(nodes) || depth > 8) throw new Error("nesting");
    for (const node of nodes) {
      if (!node || typeof node !== "object" || ++count > 300)
        throw new Error("nodes");
      result.push(node);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  let count = 0;
  walk(document.blocks, 0);
  return result;
}
export function visibleEmailAssets(document: any): string[] {
  return emailAssetIds(document, true);
}
export function emailAssetIds(document: any, visibleOnly = false): string[] {
  if (document?.schemaVersion !== 2) return [];
  const ids = new Set<string>();
  const walk = (nodes: any[]) => {
    for (const n of nodes || []) {
      if (visibleOnly && n.hidden) continue;
      if (["image", "video", "document"].includes(n.type) && n.sourceType !== "remote" && n.assetId) ids.add(n.assetId);
      if (n.type === "video" && n.thumbnailSourceType === "upload" && n.thumbnailAssetId)
        ids.add(n.thumbnailAssetId);
      if (n.type === "table") {
        const rich = (node: any) => {
          if (node.type === "image") ids.add(node.attrs?.assetId);
          for (const child of node.content || []) rich(child);
        };
        rich(n.content);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(document.blocks);
  return [...ids];
}
