import assert from "node:assert/strict";
import test from "node:test";
import { composerDirection, proseDirection } from "./text-direction.ts";

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
