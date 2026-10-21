vi.mock("common/translation.service", () => ({ TranslationService: class {} }));
const translations = { t: (key: string) => key } as any;
import { describe, it, expect, vi } from "vitest";
import { EmailContentService } from "./email-content.service";
import { normalizeEmail } from "./email.types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const content = () => ({
  subject: "Hello {{customer.name}}",
  businessIdentity: "Example store, Cairo",
  document: {
    schemaVersion: 1 as const,
    blocks: [
      {
        type: "text",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Welcome {{customer.name}}",
                  marks: [
                    { type: "bold" },
                    { type: "textStyle", attrs: { color: "#176c51" } },
                  ],
                },
              ],
            },
          ],
        },
      },
      { type: "button", label: "Your offer", url: "{{campaign.orderUrl}}" },
    ],
  },
});

describe("EmailContentService", () => {
  it.each(["en", "ar"])(
    "returns actual %s validation text from domains.json",
    (language) => {
      const catalog = JSON.parse(
        readFileSync(resolve("messages", language, "domains.json"), "utf8"),
      );
      const localized = {
        t: (key: string) =>
          key
            .split(".")
            .reduce((value, part) => value[part], { domains: catalog } as any),
      } as any;
      const renderer = new EmailContentService(localized);
      expect(() => renderer.validate({ ...content(), subject: "\n" })).toThrow(
        catalog.email.invalid_subject,
      );
      expect(catalog.email.invalid_subject).not.toContain("domains.email.");
    },
  );
  const renderer = new EmailContentService(translations);
  it("renders rich email, safe recipient values, links, footer and plain text", async () => {
    const result = await renderer.render(
      content(),
      {
        "customer.name": "<script>alert(1)</script>",
        "campaign.orderUrl": "https://example.com/offer?token=abc",
      },
      "https://example.com/unsubscribe/token",
    );
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("<strong>");
    expect(result.html).toContain("https://example.com/offer?token=abc");
    expect(result.text).not.toContain("Unsubscribe");
    expect(result.subject).toContain("<script>"); // plain header text, never interpreted as HTML
  });
  it("rejects unsafe links and unsupported HTML-like nodes", () => {
    const data = content();
    data.document.blocks[1].url = "javascript:alert(1)";
    expect(() => renderer.validate(data)).toThrow();
    const malicious = content();
    malicious.document.blocks[0].content.type = "iframe";
    expect(() => renderer.validate(malicious)).toThrow();
  });
  it("requires recipient variables and prevents subject header injection", async () => {
    await expect(renderer.render(content(), {})).rejects.toThrow();
    await expect(
      renderer.render(content(), {
        "customer.name": "Mona\r\nBcc: attacker@example.com",
        "campaign.orderUrl": "https://example.com",
      }),
    ).rejects.toThrow();
  });
  it("rejects unknown variables and excessive document size", () => {
    const data = content();
    data.subject = "{{untrusted.field}}";
    expect(() => renderer.validate(data)).toThrow();
    const big = content();
    big.businessIdentity = "x".repeat(1001);
    expect(() => renderer.validate(big)).toThrow();
  });
  it("preserves dots and plus addressing while normalizing email identity", () => {
    expect(normalizeEmail(" Person.Name+offer@Example.COM ")).toBe(
      "person.name+offer@example.com",
    );
    expect(normalizeEmail("not-an-address")).toBeNull();
    expect(normalizeEmail("a@example.com\r\nBcc: b@example.com")).toBeNull();
  });
});

describe("version 2 email designs", () => {
  const renderer = new EmailContentService(translations);
  const design = (): any => ({
    subject: "\u0645\u0631\u062d\u0628\u0627 {{customer.name}}",
    businessIdentity: "Store",
    document: {
      schemaVersion: 2,
      direction: "rtl",
      blocks: [
        {
          id: "section",
          type: "section",
          children: [
            {
              id: "column",
              type: "column",
              children: [
                {
                  id: "button",
                  type: "button",
                  label: "Hello {{customer.name}}",
                  url: "https://example.com",
                  style: {
                    backgroundColor: "#112233",
                    fontSize: 20,
                    padding: 20,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  it("renders styled RTL designs without adding unsubscribe copy to the body", async () => {
    const result = await renderer.render(
      design(),
      { "customer.name": "\u0623\u062d\u0645\u062f" },
      "https://example.com/unsubscribe",
    );
    expect(result.html).toContain("#112233");
    expect(result.html).toContain("\u0623\u062d\u0645\u062f");
    expect(result.html).not.toContain("Unsubscribe");
    expect(result.html).not.toContain("https://example.com/unsubscribe");
    expect(result.htmlBytes).toBe(Buffer.byteLength(result.html));
  });
  it("uses explicit zero text padding and Cairo when a v2 design omits defaults", async () => {
    const data = design();
    data.document.blocks[0].children[0].children[0] = {
      id: "text",
      type: "text",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        ],
      },
    };
    const result = await renderer.render(data, {
      "customer.name": "Mona",
    });
    expect(result.html).toMatch(/font-family:Cairo, sans-serif/);
    expect(result.html).toMatch(/padding:0px/);
  });
  it("accepts every font offered by the email builder", async () => {
    for (const fontFamily of [
      "Arial",
      "Tahoma",
      "Cairo",
      "Tajawal",
      "Noto Kufi Arabic",
      "Almarai",
    ]) {
      const data = design();
      data.document.defaults = { fontFamily, padding: 0 };
      expect(() => renderer.validate(data)).not.toThrow();
    }
  });
  it("renders button and parent-container appearance independently", async () => {
    const data = design();
    const button = data.document.blocks[0].children[0].children[0];
    button.style = {
      backgroundColor: "#112233",
      color: "#ffffff",
      borderColor: "#334455",
      borderWidth: 2,
      borderRadius: 7,
      paddingTop: 9,
      paddingRight: 18,
      paddingBottom: 9,
      paddingLeft: 18,
    };
    button.containerStyle = {
      backgroundColor: "#eef1f4",
      borderColor: "#778899",
      borderWidth: 1,
      borderRadius: 4,
      padding: 6,
      marginTop: 12,
      marginBottom: 14,
    };
    const result = await renderer.render(data, { "customer.name": "Mona" });
    expect(result.html).toContain("background-color:#112233");
    expect(result.html).toContain("background-color:#eef1f4");
    expect(result.html).toContain("border:2px solid #334455");
    expect(result.html).toMatch(
      /<a[^>]+style="[^"]*background-color:#112233[^"]*border:2px solid #334455[^"]*border-radius:7px/,
    );
    expect(result.html).toContain("border:1px solid #778899");
    expect(result.html).toContain("padding-top:12px");
    expect(result.html).toContain("padding-bottom:14px");
  });
  it.each(["http://example.com", "https://example.com"])(
    "accepts an absolute %s button link",
    (url) => {
      const data = design();
      data.document.blocks[0].children[0].children[0].url = url;
      expect(() => renderer.validate(data)).not.toThrow();
    },
  );
  it.each([
    "example.com",
    "click here",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "file:///tmp/message",
    "ftp://example.com/file",
    "mailto:person@example.com",
    "http://user:password@example.com",
    "https://user:password@example.com",
  ])("identifies the component containing invalid link %s", (url) => {
    const data = design();
    const button = data.document.blocks[0].children[0].children[0];
    button.url = url;
    try {
      renderer.validate(data);
      throw new Error("validation should fail");
    } catch (error: any) {
      expect(error.getResponse()).toMatchObject({
        message: "domains.email.invalid_link",
        diagnostics: [{ code: "invalid_link", elementId: button.id }],
      });
    }
  });
  it("accepts HTTP links in rich text and linked images", () => {
    const data = design();
    data.document.blocks[0].children[0].children = [
      {
        id: "text-link",
        type: "text",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Open",
                  marks: [
                    { type: "link", attrs: { href: "http://example.com" } },
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        id: "linked-image",
        type: "image",
        assetId: "123e4567-e89b-42d3-a456-426614174000",
        alt: "Example",
        url: "http://example.com/image-target",
      },
    ];
    expect(() => renderer.validate(data)).not.toThrow();
  });
  it.each(["video", "document"])(
    "validates an uploaded %s before managed assets are loaded",
    (type) => {
      const data = design();
      data.document.blocks[0].children[0].children[0] = {
        id: `${type}-block`,
        type,
        sourceType: "upload",
        assetId: "123e4567-e89b-42d3-a456-426614174000",
        ...(type === "document" ? { title: "Price list" } : {}),
        style: { width: 500, borderRadius: 8 },
      };
      expect(() => renderer.validate(data)).not.toThrow();
    },
  );
  it("renders an uploaded video as a player with a clickable fallback", async () => {
    const data = design();
    data.document.blocks[0].children[0].children[0] = {
      id: "video-block",
      type: "video",
      sourceType: "upload",
      assetId: "123e4567-e89b-42d3-a456-426614174000",
      caption: "Product demonstration",
      style: { width: 500, height: 280, borderRadius: 8 },
    };
    const withAssets = new EmailContentService(translations, {
      getMany: async () => [{
        id: "123e4567-e89b-42d3-a456-426614174000",
        url: "https://example.com/product.mp4",
      }],
    } as any);
    const result = await withAssets.render(data, { "customer.name": "Mona" }, undefined, "tenant");
    expect(result.html).toContain("<video");
    expect(result.html).toContain("controls");
    expect(result.html).toContain("https://example.com/product.mp4");
    expect(result.html).toContain("Product demonstration");
  });
  it("renders atomic rich-text variable nodes and rejects unknown ones", async () => {
    const data = design();
    data.document.blocks[0].children[0].children[0] = {
      id: "text",
      type: "text",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Welcome " },
              { type: "variable", attrs: { id: "customer.name" } },
            ],
          },
        ],
      },
    };
    const result = await renderer.render(data, { "customer.name": "Mona" });
    expect(result.html).toContain("Welcome Mona");

    data.document.blocks[0].children[0].children[0].content.content[0].content[1].attrs.id =
      "untrusted.field";
    expect(() => renderer.validate(data)).toThrow();
  });
  it("rejects unsupported styles, duplicate IDs and external image properties", () => {
    const data = design();
    data.document.blocks[0].style = { position: "absolute" };
    expect(() => renderer.validate(data)).toThrow();
    const duplicate = design();
    duplicate.document.blocks[0].children[0].id = "section";
    expect(() => renderer.validate(duplicate)).toThrow();
    const image = design();
    image.document.blocks[0].children[0].children[0] = {
      id: "image",
      type: "image",
      src: "https://external.example/image.png",
    };
    expect(() => renderer.validate(image)).toThrow();
  });
  it("omits globally hidden content", async () => {
    const data = design();
    data.document.blocks[0].hidden = true;
    expect(
      (await renderer.render(data, { "customer.name": "Sample" })).html,
    ).not.toContain("#112233");
  });
  it("omits a hidden leaf block from the final sent HTML", async () => {
    const data = design();
    const button = data.document.blocks[0].children[0].children[0];
    button.hidden = true;
    button.label = "HIDDEN CAMPAIGN BUTTON";
    const result = await renderer.render(data, { "customer.name": "Sample" });
    expect(result.html).not.toContain("HIDDEN CAMPAIGN BUTTON");
    expect(result.text).not.toContain("HIDDEN CAMPAIGN BUTTON");
  });
  it("renders a table document only when Release 2 is enabled", async () => {
    const data = design();
    data.subject = "Table";
    const header = {
      type: "tableHeader",
      attrs: { colspan: 1, rowspan: 1 },
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Header" }] },
        {
          type: "emailButton",
          attrs: {
            label: "Open",
            url: "http://example.com/table",
            style: {},
          },
        },
      ],
    };
    const table = {
      type: "table",
      content: [{ type: "tableRow", content: [header] }],
    };
    data.document.blocks[0].children[0].children = [
      {
        id: "table",
        type: "table",
        content: { type: "doc", content: [table] },
      },
    ];
    vi.stubEnv("EMAIL_TABLES_ENABLED", "false");
    expect(() => renderer.validate(data)).toThrow();
    vi.stubEnv("EMAIL_TABLES_ENABLED", "true");
    try {
      const result=await renderer.render(data);
      expect(result.html).toContain("Header");
      expect(result.html).toContain("http://example.com/table");
      expect(result.html).not.toMatch(/<table\b[^>]*>\s*<table\b/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
