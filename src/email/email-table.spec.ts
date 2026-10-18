import { describe, it, expect } from "vitest";
import { renderEmailTable } from "./email-table";
const cell = (attrs: any = {}) => ({
  type: "tableCell",
  attrs,
  content: [{ type: "paragraph" }],
});
const doc = (rows: any[]) => ({
  type: "doc",
  content: [
    {
      type: "table",
      content: rows.map((content) => ({ type: "tableRow", content })),
    },
  ],
});
const render = (value: any) =>
  renderEmailTable(
    value,
    () => "<p>Cell</p>",
    () => "Image",
  );
describe("email tables", () => {
  it("renders valid merged grids and styled cells", () => {
    const html = render(
      doc([
        [cell({ colspan: 2, backgroundColor: "#112233" })],
        [cell(), cell()],
      ]),
    );
    expect(html).toContain('colspan="2"');
    expect(html).toContain("#112233");
  });
  it("rejects overlapping spans, uneven grids and invalid cell styles", () => {
    expect(() =>
      render(doc([[cell({ rowspan: 2 }), cell()], [cell({ colspan: 2 })]])),
    ).toThrow();
    expect(() => render(doc([[cell(), cell()], [cell()]]))).toThrow();
    expect(() =>
      render(doc([[cell({ backgroundColor: "url(javascript:evil)" })]])),
    ).toThrow();
  });
  it("rejects nested tables", () => {
    const c = cell();
    c.content = [{ type: "table" }];
    expect(() => render(doc([[c]]))).toThrow();
  });
});
