import { randomUUID } from "crypto";
import { z } from "zod";
import {
  EMAIL_ALLOWED_FONTS,
  EMAIL_DEFAULT_STYLE,
} from "src/email/email-content.defaults";
import { STYLE_RULES } from "src/email/email-document";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional();
const httpsUrl = z.string().url().max(2000).refine((value) => value.startsWith("https://"), "Must be an HTTPS URL");

export const mcpEmailStyleSchema = z.object({
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  borderColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  fontFamily: z.enum(EMAIL_ALLOWED_FONTS as [string, ...string[]]).optional(),
  fontSize: z.number().min(8).max(72).optional(),
  fontWeight: z.number().min(100).max(900).optional(),
  lineHeight: z.number().min(1).max(3).optional(),
  letterSpacing: z.number().min(0).max(10).optional(),
  paragraphSpacing: z.number().min(0).max(80).optional(),
  indent: z.number().min(0).max(100).optional(),
  padding: z.number().min(0).max(100).optional(),
  paddingTop: z.number().min(0).max(100).optional(),
  paddingRight: z.number().min(0).max(100).optional(),
  paddingBottom: z.number().min(0).max(100).optional(),
  paddingLeft: z.number().min(0).max(100).optional(),
  margin: z.number().min(0).max(100).optional(),
  marginTop: z.number().min(0).max(100).optional(),
  marginRight: z.number().min(0).max(100).optional(),
  marginBottom: z.number().min(0).max(100).optional(),
  marginLeft: z.number().min(0).max(100).optional(),
  spacing: z.number().min(0).max(100).optional(),
  width: z.number().min(1).max(1600).optional(),
  height: z.number().min(1).max(1600).optional(),
  minHeight: z.number().min(0).max(300).optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  borderRadius: z.number().min(0).max(100).optional(),
  align: z.enum(["left", "center", "right", "justify"]).optional(),
  objectFit: z.enum(["contain", "cover", "fill"]).optional(),
}).strict();

const richMarkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }).strict(),
  z.object({ type: z.literal("italic") }).strict(),
  z.object({ type: z.literal("underline") }).strict(),
  z.object({ type: z.literal("strike") }).strict(),
  z.object({ type: z.literal("link"), attrs: z.object({ href: httpsUrl }).strict() }).strict(),
  z.object({
    type: z.literal("textStyle"),
    attrs: z.object({
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      fontFamily: z.enum(EMAIL_ALLOWED_FONTS as [string, ...string[]]).optional(),
      fontSize: z.string().regex(/^(?:[89]|[1-6][0-9]|7[0-2])px$/).optional(),
    }).strict(),
  }).strict(),
]);

let richNodeSchema: z.ZodTypeAny;
richNodeSchema = z.lazy(() => z.union([
  z.object({ type: z.literal("text"), text: z.string(), marks: z.array(richMarkSchema).optional() }).strict(),
  z.object({ type: z.literal("variable"), attrs: z.object({ id: z.enum(["customer.name", "customer.number", "customer.email", "campaign.orderUrl", "campaign.orderToken"]) }).strict() }).strict(),
  z.object({ type: z.literal("hardBreak") }).strict(),
  z.object({ type: z.literal("heading"), attrs: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(), content: z.array(richNodeSchema).max(2000).optional() }).strict(),
  z.object({ type: z.enum(["doc", "paragraph", "bulletList", "orderedList", "listItem", "blockquote"]), content: z.array(richNodeSchema).max(2000).optional() }).strict(),
]));

export const mcpRichTextSchema = richNodeSchema;

const base = { id, style: mcpEmailStyleSchema.optional(), containerStyle: mcpEmailStyleSchema.optional(), hidden: z.boolean().optional() };
const textBlock = z.object({ ...base, type: z.literal("text"), content: mcpRichTextSchema }).strict();
const buttonBlock = z.object({ ...base, type: z.literal("button"), label: z.string().min(1).max(1000), url: z.string().min(1).max(2000) }).strict();
const imageBlock = z.object({ ...base, type: z.literal("image"), sourceType: z.literal("remote"), sourceUrl: httpsUrl, alt: z.string().max(1000).optional(), caption: z.string().max(2000).optional(), url: z.union([httpsUrl, z.literal("")]).optional() }).strict();
const videoBlock = z.object({ ...base, type: z.literal("video"), sourceType: z.literal("remote"), sourceUrl: httpsUrl, thumbnailSourceType: z.enum(["auto", "remote"]), thumbnailUrl: httpsUrl.optional(), alt: z.string().max(1000).optional(), caption: z.string().max(2000).optional(), title: z.string().max(1000).optional() }).strict();
const documentBlock = z.object({ ...base, type: z.literal("document"), sourceType: z.literal("remote"), sourceUrl: httpsUrl, title: z.string().max(1000).optional(), content: mcpRichTextSchema.optional(), caption: z.string().max(2000).optional(), alt: z.string().max(1000).optional() }).strict();
const dividerBlock = z.object({ ...base, type: z.literal("divider") }).strict();
const spacerBlock = z.object({ ...base, type: z.literal("spacer"), height: z.number().int().min(8).max(100) }).strict();
const tableBlock = z.object({ ...base, type: z.literal("table"), content: z.object({ type: z.literal("doc"), content: z.array(z.any()).length(1) }).strict() }).strict();
const leafBlock = z.discriminatedUnion("type", [textBlock, buttonBlock, imageBlock, videoBlock, documentBlock, dividerBlock, spacerBlock, tableBlock]);
const columnBlock = z.object({ ...base, type: z.literal("column"), children: z.array(leafBlock).min(1) }).strict();
let rootBlockSchema: z.ZodTypeAny;
const sectionBlock: z.ZodTypeAny = z.lazy(() => z.object({ ...base, type: z.literal("section"), children: z.array(columnBlock).min(1).max(4) }).strict());
const wrapperBlock: z.ZodTypeAny = z.lazy(() => z.object({ ...base, type: z.literal("wrapper"), children: z.array(rootBlockSchema).min(1) }).strict());
rootBlockSchema = z.lazy(() => z.union([sectionBlock, wrapperBlock]));

export const mcpEmailDocumentSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  direction: z.enum(["ltr", "rtl"]).optional(),
  width: z.number().int().min(320).max(800).optional(),
  defaults: mcpEmailStyleSchema.optional(),
  blocks: z.array(rootBlockSchema).min(1).max(100),
}).strict();

export const mcpEmailContentSchema = z.object({
  subject: z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks"),
  preheader: z.string().max(300).optional(),
  businessIdentity: z.string().trim().min(1).max(1000),
  document: mcpEmailDocumentSchema,
}).strict();

export const mcpEmailCampaignConfigSchema = z.object({
  accountId: z.string().uuid(),
  subject: z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/.test(value), "Subject cannot contain line breaks"),
  preheader: z.string().max(300).optional(),
  businessIdentity: z.string().trim().min(1).max(1000),
  document: mcpEmailDocumentSchema,
}).strict();

export type McpEmailDiagnostic = { code: string; elementId: string | null; path: string | null; message: string };

export class McpEmailDocumentError extends Error {
  constructor(public readonly diagnostics: McpEmailDiagnostic[]) {
    super(diagnostics[0]?.message || "Invalid email document");
  }
}

function youtubeThumbnailSupported(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtu.be" || ["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host);
  } catch {
    return false;
  }
}

export function normalizeMcpEmailDocument(input: any) {
  const document = structuredClone(input);
  const seen = new Set<string>();
  let count = 0;
  const walk = (nodes: any[], path: string, depth: number) => {
    if (depth > 8) throw new McpEmailDocumentError([{ code: "maximum_depth_exceeded", elementId: null, path, message: "Email documents may not exceed 8 nested levels." }]);
    nodes.forEach((node, index) => {
      const nodePath = `${path}[${index}]`;
      count++;
      if (count > 300) throw new McpEmailDocumentError([{ code: "maximum_nodes_exceeded", elementId: null, path: nodePath, message: "Email documents may not contain more than 300 blocks." }]);
      node.id ||= randomUUID();
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(node.id) || seen.has(node.id)) {
        throw new McpEmailDocumentError([{ code: seen.has(node.id) ? "duplicate_element_id" : "invalid_element_id", elementId: node.id || null, path: `${nodePath}.id`, message: "Every supplied block id must be valid and unique." }]);
      }
      seen.add(node.id);
      if (["image", "video", "document"].includes(node.type)) {
        if (node.sourceType !== "remote") throw new McpEmailDocumentError([{ code: "mcp_remote_media_only", elementId: node.id, path: `${nodePath}.sourceType`, message: "MCP email media must use sourceType=remote with an HTTPS URL; uploads and asset IDs are not supported." }]);
        for (const forbidden of ["assetId", "thumbnailAssetId"]) if (forbidden in node) throw new McpEmailDocumentError([{ code: "mcp_upload_field_forbidden", elementId: node.id, path: `${nodePath}.${forbidden}`, message: `${forbidden} is not accepted by MCP; provide a remote HTTPS URL.` }]);
      }
      if (node.type === "video") {
        if (node.thumbnailSourceType === "upload") throw new McpEmailDocumentError([{ code: "mcp_upload_field_forbidden", elementId: node.id, path: `${nodePath}.thumbnailSourceType`, message: "MCP video thumbnails must be remote URLs or automatic YouTube thumbnails." }]);
        if ((node.thumbnailSourceType || "auto") === "auto" && !youtubeThumbnailSupported(node.sourceUrl)) throw new McpEmailDocumentError([{ code: "video_thumbnail_required", elementId: node.id, path: `${nodePath}.thumbnailUrl`, message: "A non-YouTube video requires thumbnailSourceType=remote and an HTTPS thumbnailUrl." }]);
      }
      if (node.type === "table") {
        if (process.env.EMAIL_TABLES_ENABLED !== "true") throw new McpEmailDocumentError([{ code: "tables_disabled", elementId: node.id, path: nodePath, message: "Table blocks are disabled in this environment." }]);
        const tableJson = JSON.stringify(node.content);
        if (/\"type\"\s*:\s*\"image\"/.test(tableJson)) throw new McpEmailDocumentError([{ code: "mcp_remote_media_only", elementId: node.id, path: `${nodePath}.content`, message: "MCP tables cannot contain uploaded images; place a remote image block outside the table." }]);
      }
      if (node.children) walk(node.children, `${nodePath}.children`, depth + 1);
    });
  };
  document.schemaVersion = 2;
  document.direction ||= "ltr";
  document.width ||= 600;
  document.defaults = { ...EMAIL_DEFAULT_STYLE, ...(document.defaults || {}) };
  walk(document.blocks, "document.blocks", 0);
  return document;
}

export function emailVariablesUsed(value: unknown): string[] {
  const found = new Set<string>();
  for (const match of JSON.stringify(value).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) found.add(match[1]);
  const walk = (node: any) => {
    if (node?.type === "variable" && node.attrs?.id) found.add(node.attrs.id);
    for (const child of node?.content || []) walk(child);
    for (const child of node?.children || []) walk(child);
  };
  walk(value);
  return [...found];
}

const rich = (text: string, bold = false) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text, ...(bold ? { marks: [{ type: "bold" }] } : {}) }] }] });

export const PRODUCT_OFFER_EMAIL_EXAMPLE = {
  accountId: "00000000-0000-4000-8000-000000000001",
  subject: "Limited offers selected for {{customer.name}}",
  preheader: "Save up to 35% for the next 48 hours",
  businessIdentity: "Madar · Business address",
  document: {
    schemaVersion: 2,
    direction: "ltr",
    width: 600,
    defaults: { ...EMAIL_DEFAULT_STYLE },
    blocks: [
      { type: "section", style: { backgroundColor: "#111827", padding: 20 }, children: [{ type: "column", children: [
        { type: "text", style: { align: "center", color: "#ffffff", fontSize: 24 }, content: rich("MADAR", true) },
        { type: "text", style: { align: "center", color: "#d97706", lineHeight: 1.7 }, content: rich("LIMITED-TIME COLLECTION", true) },
        { type: "text", style: { align: "center", color: "#ffffff", fontSize: 32, fontWeight: 700 }, content: rich("Deals worth getting excited about") },
        { type: "button", label: "Explore all offers →", url: "{{campaign.orderUrl}}", style: { align: "center", color: "#111827", backgroundColor: "#d97706", padding: 12, borderRadius: 8, fontWeight: 700 }, containerStyle: { margin: 8 } },
      ] }] },
      { type: "section", style: { backgroundColor: "#f4f7f5", padding: 8 }, children: [
        { type: "column", style: { backgroundColor: "#ffffff", padding: 14, borderRadius: 8 }, children: [{ type: "text", style: { align: "center", color: "#6763af", fontSize: 24 }, content: rich("35%\nMAXIMUM SAVINGS", true) }] },
        { type: "column", style: { backgroundColor: "#ffffff", padding: 14, borderRadius: 8 }, children: [{ type: "text", style: { align: "center", color: "#176c51", fontSize: 24 }, content: rich("2\nFEATURED PRODUCTS", true) }] },
        { type: "column", style: { backgroundColor: "#ffffff", padding: 14, borderRadius: 8 }, children: [{ type: "text", style: { align: "center", color: "#d97706", fontSize: 24 }, content: rich("48h\nOFFER DURATION", true) }] },
      ] },
      { type: "section", style: { backgroundColor: "#f4f7f5", padding: 8 }, children: [{ type: "column", style: { backgroundColor: "#ffffff", padding: 14, borderRadius: 8 }, children: [
        { type: "text", style: { align: "center", color: "#111827", fontSize: 24, fontWeight: 700 }, content: rich("Choose your favorite") },
        { type: "image", sourceType: "remote", sourceUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=1200&q=85", alt: "Premium wireless headphones", caption: "AUDIO FAVORITE", style: { align: "center", width: 542, borderRadius: 6 } },
        { type: "text", style: { align: "center", lineHeight: 1.7 }, content: rich("Premium Wireless Headphones — rich sound and up to 30 hours of battery life.") },
        { type: "text", style: { align: "center", color: "#6763af", fontSize: 24 }, content: rich("TODAY’S PRICE  $89", true) },
        { type: "button", label: "Shop headphones", url: "{{campaign.orderUrl}}", style: { align: "center", color: "#ffffff", backgroundColor: "#6763af", padding: 12, borderRadius: 8, fontWeight: 700 } },
        { type: "divider", style: { borderColor: "#d5dfd8", borderWidth: 1 } },
        { type: "image", sourceType: "remote", sourceUrl: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=1200&q=85", alt: "Modern everyday smart watch", caption: "SMART ESSENTIAL", style: { align: "center", width: 542, borderRadius: 6 } },
        { type: "text", style: { align: "center", color: "#176c51", fontSize: 24 }, content: rich("TODAY’S PRICE  $129", true) },
        { type: "button", label: "Shop smart watch", url: "{{campaign.orderUrl}}", style: { align: "center", color: "#ffffff", backgroundColor: "#176c51", padding: 12, borderRadius: 8, fontWeight: 700 } },
      ] }] },
    ],
  },
  variables: { "customer.name": "Ahmed", "customer.number": "+201000000000", "customer.email": "ahmed@example.com", "campaign.orderUrl": "https://getmadar.net/o/sample-token", "campaign.orderToken": "sample-token" },
  enablePurchasePage: true,
  products: [
    { name: "Premium Wireless Headphones", sku: "HEADPHONES-01", quantity: 1, price: 89, image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e" },
    { name: "Modern Smart Watch", sku: "WATCH-01", quantity: 1, price: 129, image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30" },
  ],
};

const serializeRule = (rule: RegExp | [number, number]) => rule instanceof RegExp ? { pattern: rule.source } : { minimum: rule[0], maximum: rule[1] };

export function emailBuilderCapabilities() {
  const tablesEnabled = process.env.EMAIL_TABLES_ENABLED === "true";
  return {
    schemaVersion: 2,
    canonicalSource: "The JSON document is editable source; backend MJML rendering is the delivery source of truth. Never send arbitrary HTML.",
    envelope: { required: ["accountId", "subject", "businessIdentity", "document"], optional: ["preheader"], limits: { subject: 200, preheader: 300, businessIdentity: 1000 } },
    document: { required: ["blocks"], defaults: { schemaVersion: 2, direction: "ltr", width: 600, defaults: EMAIL_DEFAULT_STYLE }, width: { minimum: 320, maximum: 800 }, directions: ["ltr", "rtl"], maximumRootBlocks: 100, maximumNodes: 300, maximumDepth: 8, maximumSerializedCharacters: 200000 },
    hierarchy: { root: ["wrapper", "section"], wrapper: ["wrapper", "section"], section: ["column"], maximumColumnsPerSection: 4, column: ["text", "button", "image", "video", "document", "divider", "spacer", ...(tablesEnabled ? ["table"] : [])] },
    commonBlockFields: { id: "Optional for MCP; generated as a UUID when omitted. Supplied ids must be unique and match [a-zA-Z0-9_-]{1,80}.", style: "Controls the visual block itself and inherits document defaults.", containerStyle: "Controls spacing/background/border around the block.", hidden: "When true, the block is not rendered." },
    blockFields: {
      text: { required: ["type", "content"], content: "Tiptap rich-text JSON" },
      button: { required: ["type", "label", "url"], notes: "url may contain supported campaign variables." },
      image: { required: ["type", "sourceType=remote", "sourceUrl"], optional: ["alt", "caption", "url", "style", "containerStyle"] },
      video: { required: ["type", "sourceType=remote", "sourceUrl", "thumbnailSourceType"], conditional: "auto is supported for YouTube URLs; all other URLs require thumbnailSourceType=remote plus thumbnailUrl." },
      document: { required: ["type", "sourceType=remote", "sourceUrl"], optional: ["title", "content", "caption"], notes: "content is editable rich-text used as the visible link." },
      divider: { required: ["type"] }, spacer: { required: ["type", "height"], height: { minimum: 8, maximum: 100 } },
      ...(tablesEnabled ? { table: { required: ["type", "content"], structure: "content is one table node; table has 1-50 tableRow nodes; each row has 1-10 tableCell/tableHeader nodes; cell content may use supported rich text or emailButton but not uploaded images; nested tables are forbidden.", rowAttributes: { height: "integer 20-600" }, cellAttributes: ["colspan", "rowspan", "colwidth", "backgroundColor", "align", "padding", "borderColor", "borderWidth", "verticalAlign(top|middle|bottom)"] } } : {}),
    },
    styles: {
      allowedFonts: EMAIL_ALLOWED_FONTS,
      rules: Object.fromEntries(Object.entries(STYLE_RULES).map(([key, rule]) => [key, serializeRule(rule)])),
      inheritance: "document.defaults are inherited; block style overrides them; containerStyle wraps the block and does not replace its typography.",
      applicableByBlock: {
        wrapper: ["backgroundColor", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "width", "borderColor", "borderWidth", "borderRadius"],
        section: ["backgroundColor", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "width", "borderColor", "borderWidth", "borderRadius"],
        column: ["backgroundColor", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "width", "borderColor", "borderWidth", "borderRadius", "align"],
        text: ["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paragraphSpacing", "indent", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderColor", "borderWidth", "borderRadius", "align"],
        button: ["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "width", "minHeight", "borderColor", "borderWidth", "borderRadius", "align"],
        image: ["backgroundColor", "width", "borderColor", "borderWidth", "borderRadius", "align"],
        video: ["backgroundColor", "width", "height", "objectFit", "borderColor", "borderWidth", "borderRadius", "align"],
        document: ["color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "lineHeight", "padding", "width", "height", "borderColor", "borderWidth", "borderRadius", "align"],
        divider: ["borderColor", "borderWidth", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "align"],
        spacer: [],
      },
      containerStyle: ["backgroundColor", "borderColor", "borderWidth", "borderRadius", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "margin", "marginTop", "marginRight", "marginBottom", "marginLeft"],
    },
    richText: { nodes: ["doc", "paragraph", "heading(level 1-3)", "bulletList", "orderedList", "listItem", "blockquote", "hardBreak", "text", "variable"], marks: ["bold", "italic", "underline", "strike", "link(HTTPS href)", "textStyle(color,fontFamily,fontSize)"], variableNode: { type: "variable", attrs: { id: "customer.name" } }, example: { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hello " }, { type: "variable", attrs: { id: "customer.name" } }] }, { type: "paragraph", content: [{ type: "text", text: "Save 35% today", marks: [{ type: "bold" }, { type: "textStyle", attrs: { color: "#d97706", fontSize: "24px" } }] }] }] } },
    variables: { supported: ["customer.name", "customer.number", "customer.email", "campaign.orderUrl", "campaign.orderToken"], purchasePageRequired: ["campaign.orderUrl", "campaign.orderToken"] },
    media: { policy: "MCP accepts remote HTTPS URLs only and never downloads them.", limits: { total: Number(process.env.EMAIL_MAX_MEDIA_BLOCKS || 10), image: Number(process.env.EMAIL_MAX_IMAGE_BLOCKS || 8), video: Number(process.env.EMAIL_MAX_VIDEO_BLOCKS || 2), document: Number(process.env.EMAIL_MAX_DOCUMENT_BLOCKS || 5) }, forbiddenFields: ["assetId", "thumbnailAssetId"], examples: {
      image: { type: "image", sourceType: "remote", sourceUrl: "https://example.com/product.jpg", alt: "Product", caption: "Featured product", style: { width: 540, align: "center", borderRadius: 8 } },
      youtubeVideo: { type: "video", sourceType: "remote", sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", thumbnailSourceType: "auto", alt: "Watch product video", style: { width: 540, height: 304, align: "center", objectFit: "cover" } },
      otherVideo: { type: "video", sourceType: "remote", sourceUrl: "https://cdn.example.com/demo.mp4", thumbnailSourceType: "remote", thumbnailUrl: "https://cdn.example.com/demo-thumbnail.jpg", alt: "Watch demo" },
      document: { type: "document", sourceType: "remote", sourceUrl: "https://example.com/catalog.pdf", content: rich("▣ View product catalog"), caption: "PDF catalog", style: { color: "#176c51", align: "center", borderWidth: 1, borderRadius: 6 } },
    } },
    featureFlags: { tablesEnabled },
    examples: {
      product_offer: {
        campaignEmail: {
          accountId: PRODUCT_OFFER_EMAIL_EXAMPLE.accountId,
          subject: PRODUCT_OFFER_EMAIL_EXAMPLE.subject,
          preheader: PRODUCT_OFFER_EMAIL_EXAMPLE.preheader,
          businessIdentity: PRODUCT_OFFER_EMAIL_EXAMPLE.businessIdentity,
          document: PRODUCT_OFFER_EMAIL_EXAMPLE.document,
        },
        previewInput: {
          subject: PRODUCT_OFFER_EMAIL_EXAMPLE.subject,
          preheader: PRODUCT_OFFER_EMAIL_EXAMPLE.preheader,
          businessIdentity: PRODUCT_OFFER_EMAIL_EXAMPLE.businessIdentity,
          document: PRODUCT_OFFER_EMAIL_EXAMPLE.document,
          variables: PRODUCT_OFFER_EMAIL_EXAMPLE.variables,
        },
        campaignFields: {
          enablePurchasePage: PRODUCT_OFFER_EMAIL_EXAMPLE.enablePurchasePage,
          products: PRODUCT_OFFER_EMAIL_EXAMPLE.products,
        },
      },
    },
  };
}
