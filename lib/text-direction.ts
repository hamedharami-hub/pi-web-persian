// A single English identifier or digit at the start must not turn a mostly
// Persian sentence into an LTR paragraph. Count letters (not numbers or
// punctuation); leave scriptless text to the browser's normal `dir=auto`.
export type ProseDirection = "rtl" | "ltr" | "auto";

const RTL_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const LETTER = /\p{L}/gu;

export function proseDirection(text: string): ProseDirection {
  let rtl = 0;
  let latin = 0;
  for (const match of text.matchAll(LETTER)) {
    if (RTL_LETTER.test(match[0])) rtl++;
    else if (LATIN_LETTER.test(match[0])) latin++;
  }
  // Ties in mixed prose prefer RTL in this Persian presentation overlay.
  if (rtl && rtl >= latin) return "rtl";
  if (latin) return "ltr";
  return "auto";
}

export function composerDirection(text: string): ProseDirection {
  // A leading ! is Pi's shell-command input, not prose; don't move its caret
  // and command text to the right because of a Persian argument or comment.
  if (/^\s*!/.test(text)) return "ltr";
  // A URL, a code span, or a fenced block at the start should not decide the
  // direction of the surrounding prose while the user is drafting Markdown.
  const withoutCode = text.replace(/```[^\n]*\n[\s\S]*?```/g, " ")
    .replace(/`+[^`\n]*`+/g, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, " ");
  return proseDirection(withoutCode);
}
