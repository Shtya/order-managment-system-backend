import { renderEmailTable } from "./email-table";
import { TranslationService } from "common/translation.service";
import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import mjml2html from "mjml";
import { convert } from "html-to-text";
import { MESSAGE_PLACEHOLDER_KEYS } from "common/message-placeholders";
import { EMAIL_ALLOWED_FONTS } from "./email-content.defaults";
import {
  emailBoxCss,
  emailOuterPadding,
  resolveEmailBlockStyle,
} from "./email-rendering";
import { EmailContent, EmailVariables } from "./email.types";
import { EmailAssetsService } from "./email-assets.service";
import {
  emailNodes,
  emailAssetIds,
  validateEmailStyle,
} from "./email-document";

export const escapeEmailHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const VARIABLES = new Set<string>(MESSAGE_PLACEHOLDER_KEYS);

@Injectable()
export class EmailContentService {
  constructor(
    private readonly translations: TranslationService,
    @Optional() private readonly assets?: EmailAssetsService,
  ) {}

  private fail(
    message: keyof import("messages.generated").I18nTranslations["domains"]["email"],
  ): never {
    throw new BadRequestException(
      this.translations.t(`domains.email.${message}`),
    );
  }
  private failElement(
    message: keyof import("messages.generated").I18nTranslations["domains"]["email"],
    elementId?: string,
  ): never {
    throw new BadRequestException({
      message: this.translations.t(`domains.email.${message}`),
      diagnostics: [
        { code: message, elementId: elementId || null },
      ],
    });
  }
  validate(content: EmailContent) {
    if (
      !content ||
      typeof content.subject !== "string" ||
      !content.subject.trim() ||
      content.subject.length > 200 ||
      /[\r\n]/.test(content.subject)
    )
      this.fail("invalid_subject");
    if (
      content.preheader !== undefined &&
      (typeof content.preheader !== "string" || content.preheader.length > 300)
    )
      this.fail("invalid_preheader");
    if (
      typeof content.businessIdentity !== "string" ||
      !content.businessIdentity.trim() ||
      content.businessIdentity.length > 1000
    )
      this.fail("business_identity_required");
    if (
      ![1, 2].includes(content.document?.schemaVersion) ||
      !Array.isArray(content.document.blocks) ||
      !content.document.blocks.length ||
      content.document.blocks.length > 100 ||
      JSON.stringify(content).length > 200_000
    )
      this.fail("invalid_document");
    if (content.document.schemaVersion === 2) {
      let invalidElement: string = null;
      try {
        const doc = content.document;
        if (
          !["ltr", "rtl"].includes(doc.direction || "ltr") ||
          (doc.width !== undefined &&
            (!Number.isInteger(doc.width) ||
              doc.width < 320 ||
              doc.width > 800))
        )
          throw new Error();
        validateEmailStyle(doc.defaults || {});
        const ids = new Set();
        const mediaCounts = { image: 0, video: 0, document: 0 };
        const walk = (nodes, parent = "root") => {
          for (const n of nodes) {
            invalidElement = typeof n?.id === "string" ? n.id : null;
            if (
              typeof n.id !== "string" ||
              !/^[a-zA-Z0-9_-]{1,80}$/.test(n.id) ||
              ids.has(n.id)
            )
              throw new Error();
            ids.add(n.id);
            if (n.type in mediaCounts) {
              mediaCounts[n.type]++;
              const total = mediaCounts.image + mediaCounts.video + mediaCounts.document;
              if (
                total > Number(process.env.EMAIL_MAX_MEDIA_BLOCKS || 10) ||
                mediaCounts.image > Number(process.env.EMAIL_MAX_IMAGE_BLOCKS || 8) ||
                mediaCounts.video > Number(process.env.EMAIL_MAX_VIDEO_BLOCKS || 2) ||
                mediaCounts.document > Number(process.env.EMAIL_MAX_DOCUMENT_BLOCKS || 5)
              ) throw new Error();
            }
            if (n.hidden !== undefined && typeof n.hidden !== "boolean")
              throw new Error();
            validateEmailStyle(n.style || {});
            validateEmailStyle(n.containerStyle || {});
            const allowed =
              parent === "root" || parent === "wrapper"
                ? ["wrapper", "section"]
                : parent === "section"
                  ? ["column"]
                  : [
                      "text",
                      "button",
                      "image",
                      "video",
                      "document",
                      "divider",
                      "spacer",
                      ...(process.env.EMAIL_TABLES_ENABLED === "true"
                        ? ["table"]
                        : []),
                    ];
            if (!allowed.includes(n.type)) 
              throw new Error();
            const fields = [
              "id",
              "type",
              "style",
              "containerStyle",
              "hidden",
              ...(["wrapper", "section", "column"].includes(n.type)
                ? ["children"]
                : ["text", "table"].includes(n.type)
                  ? ["content"]
                  : n.type === "button"
                    ? ["label", "url"]
                    : ["image", "video", "document"].includes(n.type)
                      ? ["sourceType", "assetId", "sourceUrl", "alt", "caption", "url", "title", "content"]
                      : n.type === "spacer"
                        ? ["height"]
                        : []),
            ];
            if (Object.keys(n).some((key) => !fields.includes(key)))
              throw new Error();
            if (
              ["image", "video", "document"].includes(n.type) &&
              (n.sourceType === "remote"
                ? typeof n.sourceUrl !== "string" || !n.sourceUrl.startsWith("https://")
                : !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(n.assetId || ""))
            )
              throw new Error();
            if (["wrapper", "section", "column"].includes(n.type)) {
              if (
                !Array.isArray(n.children) ||
                !n.children.length ||
                (n.type === "section" && n.children.length > 4)
              )
                throw new Error();
              walk(n.children, n.type);
            }
          }
        };
        emailNodes(doc);
        walk(doc.blocks);
      } catch {
        throw new BadRequestException({
          message: this.translations.t("domains.email.invalid_document"),
          diagnostics: [
            { code: "invalid_document", elementId: invalidElement },
          ],
        });
      }
    }
    const encoded = JSON.stringify(content);
    for (const match of encoded.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g))
      if (!VARIABLES.has(match[1])) this.fail("unknown_variable");
    // Structural validation runs through the renderer with safe stand-ins for
    // managed files. Real asset URLs are loaded and verified by render().
    const validationAssets = new Map(
      emailAssetIds(content.document).map((id) => [
        id,
        {
          id,
          url: "https://example.com/media-preview",
          originalName: "Document",
          variants: [{ url: "https://example.com/image-preview.png" }],
        },
      ]),
    );
    this.blocks(
      content,
      Object.fromEntries(
        [...VARIABLES].map((k) => [
          k,
          k.endsWith("Url") ? "https://example.com/preview" : "Sample",
        ]),
      ),
      validationAssets,
    );
  }
  private hydrate(value: unknown, variables: EmailVariables) {
    if (typeof value !== "string") this.fail("invalid_text");
    return String(value).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => {
      if (
        !VARIABLES.has(key) ||
        !Object.prototype.hasOwnProperty.call(variables, key) ||
        typeof variables[key] !== "string" ||
        !variables[key].trim()
      )
        this.fail("missing_variable");
      return variables[key];
    });
  }
  private url(value: unknown, variables: EmailVariables, elementId?: string) {
    const text = this.hydrate(value, variables);
    try {
      const url = new URL(text);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        this.failElement("invalid_link", elementId);
      return escapeEmailHtml(url.href);
    } catch(error) {
      return this.failElement("invalid_link", elementId);
    }
  }
  private rich(
    node: any,
    variables: EmailVariables,
    depth = 0,
    elementId?: string,
  ): string {
    if (!node || depth > 15 || typeof node !== "object")
      this.fail("invalid_rich_text");
    if (node.type === "variable") {
      const key = node.attrs?.id;
      if (
        typeof key !== "string" ||
        !VARIABLES.has(key) ||
        Object.keys(node).some((field) => !["type", "attrs"].includes(field)) ||
        Object.keys(node.attrs || {}).some((field) => field !== "id")
      )
        this.fail("unknown_variable");
      return escapeEmailHtml(this.hydrate(`{{${key}}}`, variables));
    }
    if (node.type === "text") {
      let result = escapeEmailHtml(this.hydrate(node.text, variables));
      if (node.marks && (!Array.isArray(node.marks) || node.marks.length > 10))
        this.fail("invalid_marks");
      for (const mark of node.marks || []) {
        if (["bold", "italic", "underline", "strike"].includes(mark.type)) {
          const tag = {
            bold: "strong",
            italic: "em",
            underline: "u",
            strike: "s",
          }[mark.type];
          result = `<${tag}>${result}</${tag}>`;
        } else if (mark.type === "textStyle") {
          const attrs = mark.attrs || {};
          const styles = [];
          for (const [key, value] of Object.entries(attrs)) {
            if (value === null) continue;
            if (key === "color" && /^#[0-9a-f]{6}$/i.test(String(value)))
              styles.push(`color:${value}`);
            else if (
              key === "fontFamily" &&
              new RegExp(
                `^(${EMAIL_ALLOWED_FONTS.map((font) => font.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
              ).test(String(value))
            )
              styles.push(`font-family:${value},sans-serif`);
            else if (
              key === "fontSize" &&
              /^(?:[89]|[1-6][0-9]|7[0-2])px$/.test(String(value))
            )
              styles.push(`font-size:${value}`);
            else this.fail("invalid_marks");
          }
          result = `<span style="${styles.join(";")}">${result}</span>`;
        } else if (mark.type === "link")
          result = `<a href="${this.url(mark.attrs?.href, variables, elementId)}">${result}</a>`;
        else this.fail("unsupported_mark");
      }
      return result;
    }
    if (node.type === "hardBreak") return "<br />";
    const tags = {
      doc: "",
      paragraph: "p",
      bulletList: "ul",
      orderedList: "ol",
      listItem: "li",
      blockquote: "blockquote",
    };
    const tag =
      node.type === "heading" && [1, 2, 3].includes(node.attrs?.level)
        ? `h${node.attrs.level}`
        : tags[node.type];
    if (
      tag === undefined ||
      (node.content &&
        (!Array.isArray(node.content) || node.content.length > 2000))
    )
      this.fail("unsupported_node");
    const inner = (node.content || [])
      .map((child) => this.rich(child, variables, depth + 1, elementId))
      .join("");
    const headingStyle =
      node.type === "heading"
        ? {
            1: "font-size:32px;font-weight:700;line-height:1.25;margin:0 0 0.5em",
            2: "font-size:24px;font-weight:700;line-height:1.3;margin:0 0 0.5em",
            3: "font-size:19px;font-weight:700;line-height:1.35;margin:0 0 0.5em",
          }[node.attrs.level]
        : null;
    return tag
      ? `<${tag}${headingStyle ? ` style="${headingStyle}"` : ""}>${inner}</${tag}>`
      : inner;
  }
  private style(style: any = {}, type = "text") {
    const names = {
      color: "color",
      backgroundColor: "background-color",
      borderColor: "border-color",
      fontFamily: "font-family",
      fontSize: "font-size",
      fontWeight: "font-weight",
      lineHeight: "line-height",
      letterSpacing: "letter-spacing",
      padding: "padding",
      paddingTop: "padding-top",
      paddingBottom: "padding-bottom",
      paddingLeft: "padding-left",
      paddingRight: "padding-right",
      align: "align",
      width: "width",
      borderRadius: "border-radius",
      borderWidth: "border-width",
    };
    const allowed = [
      "padding",
      "paddingTop",
      "paddingBottom",
      "paddingLeft",
      "paddingRight",
      ...(["text", "button", "table"].includes(type)
        ? [
            "color",
            "fontFamily",
            "fontSize",
            "fontWeight",
            "lineHeight",
            "letterSpacing",
            "align",
          ]
        : []),
      ...(["image", "button", "column", "divider"].includes(type)
        ? ["width", "align", "borderRadius"]
        : []),
      ...(["wrapper", "section", "column", "button"].includes(type)
        ? ["backgroundColor", "borderRadius"]
        : []),
      ...(type === "divider" ? ["borderColor", "borderWidth", "align"] : []),
    ];
    const sideKeys=["paddingTop","paddingRight","paddingBottom","paddingLeft"];
    const hasButtonSides=type === "button" && sideKeys.some(key=>style[key]!==undefined);
    const innerPadding=hasButtonSides ? ` inner-padding="${sideKeys.map(key=>(style[key]??style.padding??10)+"px").join(" ")}"` : "";
    return Object.entries(style)
      .filter(([key]) => names[key] && allowed.includes(key) && !(type === "button" && (sideKeys.includes(key) || (hasButtonSides && key === "padding"))))
      .map(([key, value]) => {
        const units =
          typeof value === "number" &&
          !["fontWeight", "lineHeight"].includes(key)
            ? "px"
            : "";
        return `${type === "button" && key === "padding" ? "inner-padding" : names[key]}="${escapeEmailHtml(String(value) + (key === "fontFamily" ? ", sans-serif" : units))}"`;
      })
      .join(" ") + innerPadding;
  }
  private boxCss(style: any = {}) {
    return emailBoxCss(style);
  }
  private outerPadding(style: any = {}, legacy?: number) {
    return emailOuterPadding(style, legacy);
  }
  private youtubeEmbedUrl(value: string) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      let videoId = "";
      if (host === "youtu.be")
        videoId = url.pathname.split("/").filter(Boolean)[0] || "";
      if (["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
        if (url.pathname === "/watch") videoId = url.searchParams.get("v") || "";
        else if (/^\/(embed|shorts)\//.test(url.pathname))
          videoId = url.pathname.split("/")[2] || "";
      }
      return /^[A-Za-z0-9_-]{6,20}$/.test(videoId)
        ? `https://www.youtube-nocookie.com/embed/${videoId}`
        : null;
    } catch {
      return null;
    }
  }
  private blocks(
    content: EmailContent,
    variables: EmailVariables,
    assets = new Map<string, any>(),
  ) {
    const v2 = content.document.schemaVersion === 2;
    const render = (b: any): string => {
      if (!b || typeof b !== "object" || typeof b.type !== "string")
        this.fail("invalid_block");
      if (b.hidden === true) return "";
      const style = v2
        ? resolveEmailBlockStyle(content.document.defaults, b.style)
        : { ...(content.document.defaults || {}), ...(b.style || {}) };
      const containerStyle = b.containerStyle || {};
      const attrs = v2 ? this.style(style, b.type) : "";
      if (["wrapper", "section", "column"].includes(b.type) && v2) {
        const containerStyle = Object.fromEntries(
          Object.entries(b.style || {}).filter(([k]) =>
            [
              "backgroundColor",
              "padding",
              "paddingTop",
              "paddingBottom",
              "paddingLeft",
              "paddingRight",
              "width",
              "borderRadius",
            ].includes(k),
          ),
        );
        return `<mj-${b.type} ${this.style(containerStyle, b.type)} ${style.borderWidth ? `border="${style.borderWidth}px solid ${style.borderColor || "#222222"}"` : ""} direction="${content.document.direction || "ltr"}">${b.children.map(render).join("")}</mj-${b.type}>`;
      }
      if (b.type === "table") {
        if (process.env.EMAIL_TABLES_ENABLED !== "true")
          this.fail("unsupported_block");
        try {
          const table = renderEmailTable(
            b.content,
            (n) => this.rich(n, variables, 0, b.id),
            (n) => {
              if (n.type === "image") {
                const asset = assets.get(n.attrs?.assetId),
                  variant = asset?.variants?.[asset.variants.length - 1];
                if (
                  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                    n.attrs?.assetId || "",
                  )
                )
                  this.fail("invalid_document");
                const width = n.attrs?.width;
                if (
                  width != null &&
                  (!Number.isInteger(width) || width < 1 || width > 1600)
                )
                  this.fail("invalid_document");
                return `<img src="${this.url(variant?.url || "https://example.com/preview.png", variables, b.id)}" alt="${escapeEmailHtml(this.hydrate(n.attrs?.alt || "", variables))}" style="max-width:100%;height:auto" ${width ? `width="${width}"` : ""}/>`;
              }
              validateEmailStyle(n.attrs?.style || {});
              const style = n.attrs?.style || {};
              return `<a href="${this.url(n.attrs?.url, variables, b.id)}" style="display:inline-block;padding:${style.padding ?? 10}px;background-color:${style.backgroundColor || "#176c51"};color:${style.color || "#ffffff"};border-radius:${style.borderRadius || 0}px">${escapeEmailHtml(this.hydrate(n.attrs?.label, variables))}</a>`;
            },
          );
          return `<mj-text ${this.outerPadding(containerStyle)}><div style="${this.boxCss(containerStyle)}"><div style="${this.boxCss(style)}">${table}</div></div></mj-text>`;
        } catch {
          this.fail("invalid_document");
        }
      }
      if (b.type === "text") {
        if (!v2)
          return `<mj-text line-height="1.7">${this.rich(b.content, variables, 0, b.id)}</mj-text>`;
        const html = this.rich(b.content, variables, 0, b.id);
        const extra = `margin:0 0 ${style.paragraphSpacing || 0}px;text-indent:${style.indent || 0}px`;
        const typography = Object.fromEntries(
          Object.entries({ lineHeight: 1.7, ...style }).filter(
            ([key]) =>
              ![
                "backgroundColor",
                "borderColor",
                "borderWidth",
                "borderRadius",
                "padding",
                "paddingTop",
                "paddingRight",
                "paddingBottom",
                "paddingLeft",
              ].includes(key),
          ),
        );
        return `<mj-text ${this.outerPadding(containerStyle)} ${this.style(typography)}><div style="${this.boxCss(containerStyle)}"><div style="direction:${content.document.direction || "ltr"};${this.boxCss(style)}">${html.replace(/<p>/g, `<p style="${extra}">`)}</div></div></mj-text>`;
      }
      if (b.type === "button" && !v2)
        return `<mj-button background-color="#176c51" href="${this.url(b.url, variables, b.id)}">${escapeEmailHtml(this.hydrate(b.label, variables))}</mj-button>`;
      if (b.type === "button")
        return `<mj-text ${this.outerPadding(containerStyle, style.spacing)}><div style="${this.boxCss(containerStyle)}"><table role="presentation" border="0" cellpadding="0" cellspacing="0" align="${style.align || "center"}" ${style.width ? `width="${style.width}"` : ""}><tbody><tr><td style="${style.minHeight ? `height:${style.minHeight}px;` : ""}text-align:center"><a href="${this.url(b.url, variables, b.id)}" style="display:inline-block;box-sizing:border-box;${style.width ? "width:100%;" : ""}${this.boxCss({ padding: 10, ...style })};color:${style.color || "#ffffff"};font-family:${style.fontFamily || "Cairo"},sans-serif;font-size:${style.fontSize || 16}px;font-weight:${style.fontWeight || 700};line-height:${style.lineHeight || 1.2};${style.letterSpacing !== undefined ? `letter-spacing:${style.letterSpacing}px;` : ""}text-align:center;text-decoration:none">${escapeEmailHtml(this.hydrate(b.label, variables))}</a></td></tr></tbody></table></div></mj-text>`;
      if (b.type === "image") {
        const asset = assets.get(b.assetId);
        const src = v2
          ? (b.sourceType === "remote" ? b.sourceUrl : asset?.variants?.[asset.variants.length - 1]?.url) ||
            "https://example.com/preview.png"
          : b.src;
        const image = `<img src="${this.url(src, variables, b.id)}" alt="${escapeEmailHtml(this.hydrate(b.alt || "", variables))}" style="display:inline-block;max-width:100%;height:auto;${style.width ? `width:${style.width}px;` : ""}${style.backgroundColor ? `background-color:${style.backgroundColor};` : ""}${style.borderWidth ? `border:${style.borderWidth}px solid ${style.borderColor || "#222222"};` : ""}${style.borderRadius ? `border-radius:${style.borderRadius}px;` : ""}" />`;
        return `<mj-text ${this.outerPadding(containerStyle)}><div style="${this.boxCss(containerStyle)};text-align:${style.align || "center"}">${b.url ? `<a href="${this.url(b.url, variables, b.id)}">${image}</a>` : image}${b.caption ? `<div style="margin-top:6px;color:#64748b;font-size:12px">${escapeEmailHtml(this.hydrate(b.caption, variables))}</div>` : ""}</div></mj-text>`;
      }
      if (b.type === "video" || b.type === "document") {
        const asset = assets.get(b.assetId);
        const href = b.sourceType === "remote" ? b.sourceUrl : asset?.url;
        const hydratedHref = this.hydrate(href, variables);
        const safeHref = this.url(hydratedHref, {}, b.id);
        const width = style.width || 600;
        const height = style.height ? `height:${style.height}px;` : "";
        const border = `${style.borderWidth ?? 1}px solid ${style.borderColor || "#d5dfd8"}`;
        const radius = style.borderRadius ?? 6;
        const background = style.backgroundColor || "#f8fafc";
        const caption = b.caption
          ? `<div style="margin-top:6px;color:#64748b;font-size:12px">${escapeEmailHtml(this.hydrate(b.caption, variables))}</div>`
          : "";
        if (b.type === "video") {
          const youtube = this.youtubeEmbedUrl(hydratedHref);
          const player = youtube
            ? `<iframe src="${escapeEmailHtml(youtube)}" title="Video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen style="display:inline-block;box-sizing:border-box;width:${width}px;max-width:100%;height:${style.height || 338}px;border:${border};border-radius:${radius}px;background:${background}"></iframe>`
            : `<video controls playsinline preload="metadata" src="${safeHref}" style="display:inline-block;box-sizing:border-box;width:${width}px;max-width:100%;${height}border:${border};border-radius:${radius}px;background:${background}"><a href="${safeHref}" style="color:#176c51;font-weight:700;text-decoration:none">▶ Watch video</a></video>`;
          return `<mj-text ${this.outerPadding(containerStyle)}><div style="${this.boxCss(containerStyle)};text-align:${style.align || "center"}">${player}${caption}<div style="margin-top:6px;font-size:12px"><a href="${safeHref}" style="color:#176c51;text-decoration:underline">Watch video</a></div></div></mj-text>`;
        }
        const fallbackTitle = b.title || asset?.originalName || "Open document";
        const documentContent = b.content
          ? this.rich(b.content, variables, 0, b.id).replace(/<p>/g, '<p style="margin:0">')
          : `▣ ${escapeEmailHtml(this.hydrate(fallbackTitle, variables))}`;
        return `<mj-text ${this.outerPadding(containerStyle)}><div style="${this.boxCss(containerStyle)};text-align:${style.align || "center"}"><a href="${safeHref}" style="display:inline-block;box-sizing:border-box;width:${width}px;max-width:100%;${height}padding:${b.style?.padding ?? 16}px;border:${border};border-radius:${radius}px;background:${background};color:#176c51;font-family:${style.fontFamily || "Cairo"},sans-serif;font-size:${style.fontSize || 16}px;font-weight:${style.fontWeight || 400};line-height:${style.lineHeight || 1.2};text-align:${style.align || "center"};text-decoration:none"><span>${documentContent}</span></a>${caption}</div></mj-text>`;
      }
      if (b.type === "divider" && !v2)
        return '<mj-divider border-color="#d5dfd8" />';
      if (b.type === "divider")
        return `<mj-text ${this.outerPadding(containerStyle)}><div style="${this.boxCss(containerStyle)}"><div style="${this.boxCss(style)}"><hr style="margin:0;border:0;border-top:${style.borderWidth || 1}px solid ${style.borderColor || "#d5dfd8"}" /></div></div></mj-text>`;
      if (
        b.type === "spacer" &&
        Number.isInteger(b.height) &&
        b.height >= 8 &&
        b.height <= 100
      )
        return `<mj-text ${this.outerPadding(containerStyle)}><div style="${this.boxCss(containerStyle)}"><div style="height:${b.height}px;line-height:${b.height}px">&nbsp;</div></div></mj-text>`;
      return this.fail("unsupported_block");
    };
    return content.document.blocks.map(render).join("");
  }
  async render(
    content: EmailContent,
    variables: EmailVariables = {},
    unsubscribeUrl?: string,
    adminId?: string,
  ) {
    this.validate(content);
    if (
      !variables ||
      typeof variables !== "object" ||
      Array.isArray(variables) ||
      Object.values(variables).some(
        (v) => typeof v !== "string" || v.length > 10_000,
      )
    )
      this.fail("invalid_variables");
    const subject = this.hydrate(content.subject, variables);
    if (/[\r\n]/.test(subject) || subject.length > 300)
      this.fail("invalid_subject");
    const managed =
      content.document.schemaVersion === 2
        ? emailAssetIds(content.document)
        : [];
    const rows = managed.length
      ? await this.assets?.getMany(adminId, managed)
      : [];
    if (managed.length && !rows) this.fail("invalid_document");
    const assetMap = new Map((rows || []).map((a) => [a.id, a]));
    const rootAttributes =
      content.document.schemaVersion === 2
        ? ` dir="${content.document.direction || "ltr"}" lang="${content.document.direction === "rtl" ? "ar" : "en"}"`
        : "";
    const footer = `<mj-text font-family="Cairo, Arial, sans-serif" font-size="11px" color="#637469" align="center" padding="0px">${escapeEmailHtml(content.businessIdentity)}</mj-text>`;
    const fonts = `<mj-font name="Cairo" href="https://fonts.googleapis.com/css?family=Cairo:400,500,700" /><mj-font name="Tajawal" href="https://fonts.googleapis.com/css?family=Tajawal:400,500,700" /><mj-font name="Noto Kufi Arabic" href="https://fonts.googleapis.com/css?family=Noto+Kufi+Arabic:400,500,700" /><mj-font name="Almarai" href="https://fonts.googleapis.com/css?family=Almarai:400,700" />`;
    const result = await mjml2html(
      `<mjml${rootAttributes}><mj-head>${fonts}<mj-preview>${escapeEmailHtml(this.hydrate(content.preheader || "", variables))}</mj-preview></mj-head><mj-body width="${content.document.width || 600}px">${content.document.schemaVersion === 2 ? this.blocks(content, variables, assetMap) + `<mj-section padding="0px"><mj-column>${footer}</mj-column></mj-section>` : `<mj-section><mj-column>${this.blocks(content, variables, assetMap)}${footer}</mj-column></mj-section>`}</mj-body></mjml>`,
      { validationLevel: "strict", filePath: undefined },
    );
    return {
      subject,
      html: result.html,
      text: convert(result.html, { wordwrap: 100 }),
      htmlBytes: Buffer.byteLength(result.html, "utf8"),
      diagnostics:
        Buffer.byteLength(result.html, "utf8") >= 90 * 1024
          ? [
              {
                code:
                  Buffer.byteLength(result.html, "utf8") >= 102 * 1024
                    ? "gmail_clipping"
                    : "html_size",
                elementId: null,
              },
            ]
          : [],
    };
  }
}
