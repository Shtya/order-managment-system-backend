vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
import { describe, expect, it, vi } from "vitest";
import { EmailContentService } from "../../email/email-content.service";
import {
  emailBuilderCapabilities,
  McpEmailDocumentError,
  mcpEmailDocumentSchema,
  normalizeMcpEmailDocument,
  PRODUCT_OFFER_EMAIL_EXAMPLE,
} from "./mcp-email-document";

const translations = { t: (key: string) => key } as any;

describe("MCP email document contract", () => {
  it("normalizes and renders the product-offer reference document", async () => {
    const parsed = mcpEmailDocumentSchema.parse(PRODUCT_OFFER_EMAIL_EXAMPLE.document);
    const document = normalizeMcpEmailDocument(parsed);
    const ids: string[] = [];
    const walk = (nodes: any[]) => nodes.forEach((node) => {
      ids.push(node.id);
      if (node.children) walk(node.children);
    });
    walk(document.blocks);
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.width).toBe(600);

    const service = new EmailContentService(translations);
    const content = {
      subject: PRODUCT_OFFER_EMAIL_EXAMPLE.subject,
      preheader: PRODUCT_OFFER_EMAIL_EXAMPLE.preheader,
      businessIdentity: PRODUCT_OFFER_EMAIL_EXAMPLE.businessIdentity,
      document,
    };
    service.validate(content as any);
    const rendered = await service.render(content as any, PRODUCT_OFFER_EMAIL_EXAMPLE.variables);
    expect(rendered.html).toContain("Premium Wireless Headphones");
    expect(rendered.subject).toContain("Ahmed");
  });

  it("requires a thumbnail for a non-YouTube remote video", () => {
    const document = {
      blocks: [{ type: "section", children: [{ type: "column", children: [{ type: "video", sourceType: "remote", sourceUrl: "https://cdn.example.com/demo.mp4", thumbnailSourceType: "auto" }] }] }],
    };
    expect(() => normalizeMcpEmailDocument(document)).toThrowError(McpEmailDocumentError);
    try {
      normalizeMcpEmailDocument(document);
    } catch (error) {
      expect((error as McpEmailDocumentError).diagnostics[0]).toMatchObject({ code: "video_thumbnail_required", path: expect.stringContaining("thumbnailUrl") });
    }
  });

  it("rejects upload fields and duplicate ids", () => {
    const upload = { blocks: [{ type: "section", children: [{ type: "column", children: [{ type: "image", sourceType: "upload", assetId: "x" }] }] }] };
    expect(() => normalizeMcpEmailDocument(upload)).toThrowError(McpEmailDocumentError);
    const duplicate = { blocks: [{ id: "same", type: "section", children: [{ id: "same", type: "column", children: [{ type: "text", content: { type: "doc", content: [] } }] }] }] };
    expect(() => normalizeMcpEmailDocument(duplicate)).toThrowError(McpEmailDocumentError);
  });

  it("reflects runtime media limits and table flag", () => {
    vi.stubEnv("EMAIL_MAX_MEDIA_BLOCKS", "7");
    vi.stubEnv("EMAIL_TABLES_ENABLED", "false");
    const capabilities = emailBuilderCapabilities() as any;
    expect(capabilities.media.limits.total).toBe(7);
    expect(capabilities.featureFlags.tablesEnabled).toBe(false);
    expect(capabilities.hierarchy.column).not.toContain("table");
    vi.unstubAllEnvs();
  });

  it("publishes a preview-ready version of the real example", () => {
    const capabilities = emailBuilderCapabilities() as any;
    const preview = capabilities.examples.product_offer.previewInput;
    expect(preview).not.toHaveProperty("accountId");
    expect(preview).not.toHaveProperty("products");
    expect(preview.variables["customer.name"]).toBe("Ahmed");
    expect(mcpEmailDocumentSchema.safeParse(preview.document).success).toBe(true);
  });

  it("keeps upload-only fields outside the MCP schema", () => {
    const document = structuredClone(PRODUCT_OFFER_EMAIL_EXAMPLE.document) as any;
    document.blocks[2].children[0].children[1] = {
      type: "image",
      sourceType: "upload",
      assetId: "00000000-0000-4000-8000-000000000001",
    };
    const result = mcpEmailDocumentSchema.safeParse(document);
    expect(result.success).toBe(false);
  });
});
