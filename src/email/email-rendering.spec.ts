import {
  emailBoxCss,
  emailOuterPadding,
  resolveEmailBlockStyle,
} from "./email-rendering";

describe("email rendering contract", () => {
  it("uses canonical defaults and block precedence", () => {
    expect(resolveEmailBlockStyle({}, {})).toMatchObject({
      fontFamily: "Cairo",
      fontSize: 16,
      color: "#222222",
      padding: 0,
    });
    expect(
      resolveEmailBlockStyle({ fontSize: 18 }, { color: "#123456" }),
    ).toMatchObject({ fontSize: 18, color: "#123456" });
  });

  it("keeps outer margin and inner padding independent", () => {
    expect(emailOuterPadding({ margin: 4, marginTop: 12, padding: 99 })).toBe(
      'padding="4px" padding-top="12px"',
    );
    expect(emailBoxCss({ padding: 8, paddingLeft: 16 })).toBe(
      "padding:8px;padding-left:16px",
    );
  });
});
