import assert from "node:assert/strict";
import test from "node:test";
import { composerDirection, proseDirection, rehypeProseDirection } from "./text-direction.ts";

test("direction follows prose, not the first Latin letter or digit", () => {
  for (const text of ["A این جمله فارسی است", "Hello متن فارسی ادامه دارد", "1 متن فارسی ادامه دارد", "API را نصب کن", "Hello فارسی", "متن فارسی API", "12: سلام"])
    assert.equal(proseDirection(text), "rtl", text);
  for (const text of ["Hello world!", "This English sentence includes سلام as a short quote.", "سلام is a greeting in English."])
    assert.equal(proseDirection(text), "ltr", text);
  assert.equal(proseDirection("12345 -> /tmp/file"), "ltr", "Latin file path is still LTR");
  assert.equal(proseDirection("12345 + 789"), "auto", "numbers alone do not decide direction");
});

test("composer ignores leading code and links but keeps shell input LTR", () => {
  assert.equal(composerDirection("`API` متن فارسی"), "rtl");
  assert.equal(composerDirection("https://example.org/help متن فارسی"), "rtl");
  assert.equal(composerDirection("```js\nconst x = 1;\n```\nمتن فارسی"), "rtl");
  assert.equal(composerDirection("!echo سلام"), "ltr");
  assert.equal(composerDirection("Hello world"), "ltr");
  assert.equal(composerDirection("42"), "auto");
});

test("bounded sampling handles multi-megabyte inputs quickly and single-pass rehypeProseDirection sets dir on blocks", () => {
  const hugeRtl = "A " + "متن فارسی ".repeat(200_000);
  const t0 = performance.now();
  assert.equal(proseDirection(hugeRtl), "rtl");
  assert.equal(proseDirection(hugeRtl), "rtl"); // cached hit
  assert.equal(composerDirection(hugeRtl), "rtl");
  assert.ok(performance.now() - t0 < 50, "multi-MB proseDirection and composerDirection stay fast");

  const tree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "ul",
        properties: {},
        children: [
          { type: "element", tagName: "li", properties: {}, children: [{ type: "text", value: "API را نصب کن" }] },
          { type: "element", tagName: "li", properties: {}, children: [{ type: "text", value: "English instructions for this item" }] },
          { type: "element", tagName: "li", properties: {}, children: [{ type: "text", value: "1 متن فارسی ادامه دارد" }] },
        ],
      },
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          { type: "element", tagName: "code", properties: {}, children: [{ type: "text", value: "EnglishIdentifier" }] },
          { type: "text", value: " متن فارسی" },
        ],
      },
    ],
  };
  rehypeProseDirection()(tree);
  assert.equal(tree.children[0].properties.dir, "rtl");
  assert.equal(tree.children[0].children[0].properties.dir, "rtl");
  assert.equal(tree.children[0].children[1].properties.dir, "ltr");
  assert.equal(tree.children[0].children[2].properties.dir, "rtl");
  assert.equal(tree.children[1].properties.dir, "rtl");
  assert.equal(tree.children[1].children[0].properties.dir, "ltr");
});
