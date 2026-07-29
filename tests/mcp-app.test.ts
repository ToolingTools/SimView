import { describe, expect, test } from "bun:test";
import { inlineAppModule } from "../packages/mcp/src/app-html";

describe("MCP App HTML", () => {
  test("inlines minified JavaScript without interpreting replacement tokens", () => {
    const template = [
      "<html><body>",
      '<script type="module" src="./preview.js"></script>',
      "</body></html>",
    ].join("");
    const script = "const patterns = \"$& $` $'\"; const close = \"</script>\";";

    const html = inlineAppModule(template, script);

    expect(html).not.toContain('src="./preview.js"');
    expect(html).toContain("$& $` $'");
    expect(html).toContain("<\\/script>");
    expect(html.match(/<script type="module">/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});
