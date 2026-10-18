import { validateEmailStyle } from "./email-document";
const escape = (value: any) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Reject malformed spans before emitting table HTML. Nested tables are unsupported. */
export function renderEmailTable(
  document: any,
  rich: (node: any) => string,
  media: (node: any) => string,
) {
  if (
    document?.type !== "doc" ||
    document.content?.length !== 1 ||
    document.content[0].type !== "table"
  )
    throw new Error("table");
  const table = document.content[0],
    rows = table.content;
  if (!Array.isArray(rows) || !rows.length || rows.length > 50)
    throw new Error("rows");
  const occupied: boolean[][] = Array.from({ length: rows.length }, () => []);
  let expectedWidth = 0;
  const output = rows
    .map((row: any, r: number) => {
      if (
        row.type !== "tableRow" ||
        !row.content?.length ||
        row.content.length > 10
      )
        throw new Error("row");
      if (row.attrs && Object.keys(row.attrs).some((key) => key !== "height"))
        throw new Error("row attribute");
      const rowHeight = row.attrs?.height;
      if (
        rowHeight != null &&
        (!Number.isInteger(rowHeight) || rowHeight < 20 || rowHeight > 600)
      )
        throw new Error("row height");
      let c = 0;
      const cells = row.content
        .map((cell: any) => {
          while (occupied[r][c]) c++;
          if (!["tableCell", "tableHeader"].includes(cell.type))
            throw new Error("cell");
          const attrs = cell.attrs || {},
            colspan = attrs.colspan ?? 1,
            rowspan = attrs.rowspan ?? 1;
          if (
            ![colspan, rowspan].every((n) => Number.isInteger(n) && n >= 1) ||
            c + colspan > 10 ||
            r + rowspan > rows.length
          )
            throw new Error("span");
          for (let y = r; y < r + rowspan; y++)
            for (let x = c; x < c + colspan; x++) {
              if (occupied[y][x]) throw new Error("overlap");
              occupied[y][x] = true;
            }
          for (const key of Object.keys(attrs))
            if (
              ![
                "colspan",
                "rowspan",
                "colwidth",
                "backgroundColor",
                "align",
                "padding",
                "borderColor",
                "borderWidth",
                "verticalAlign",
              ].includes(key)
            )
              throw new Error("cell attribute");
          validateEmailStyle(
            Object.fromEntries(
              Object.entries(attrs).filter(
                ([key, value]) =>
                  value != null &&
                  [
                    "backgroundColor",
                    "align",
                    "padding",
                    "borderColor",
                    "borderWidth",
                  ].includes(key),
              ),
            ),
          );
          if (
            attrs.verticalAlign &&
            !["top", "middle", "bottom"].includes(attrs.verticalAlign)
          )
            throw new Error("vertical align");
          if (
            attrs.colwidth &&
            (!Array.isArray(attrs.colwidth) ||
              attrs.colwidth.length !== colspan ||
              attrs.colwidth.some(
                (w) => !Number.isInteger(w) || w < 20 || w > 1600,
              ))
          )
            throw new Error("width");
          const width = attrs.colwidth?.reduce((a, b) => a + b, 0);
          const content = (cell.content || [])
            .map((node: any) => {
              const check = (n: any) => {
                if (n.type === "table") throw new Error("nested table");
                for (const child of n.content || []) check(child);
              };
              check(node);
              return ["image", "emailButton"].includes(node.type)
                ? media(node)
                : rich(node);
            })
            .join("");
          const tag = cell.type === "tableHeader" ? "th" : "td";
          const style = `padding:${attrs.padding ?? 8}px;border:${attrs.borderWidth ?? 1}px solid ${attrs.borderColor || "#dddddd"};text-align:${attrs.align || "left"};vertical-align:${attrs.verticalAlign || "top"};${attrs.backgroundColor ? `background-color:${attrs.backgroundColor};` : ""}${width ? `width:${width}px;` : ""}`;
          c += colspan;
          return `<${tag} ${tag === "th" ? 'scope="col"' : ""} colspan="${colspan}" rowspan="${rowspan}" style="${escape(style)}">${content}</${tag}>`;
        })
        .join("");
      const width = occupied[r].length;
      if (r === 0) expectedWidth = width;
      if (
        width !== expectedWidth ||
        Array.from({ length: width }, (_, x) => occupied[r][x]).some(
          (value) => !value,
        )
      )
        throw new Error("grid");
      return `<tr ${rowHeight ? `height="${rowHeight}" style="height:${rowHeight}px"` : ""}>${cells}</tr>`;
    })
    .join("");
  return `<table style="width:100%;border-collapse:collapse;table-layout:fixed"><tbody>${output}</tbody></table>`;
}
