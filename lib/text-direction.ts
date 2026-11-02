// A single English identifier or digit at the start must not turn a mostly
// Persian sentence into an LTR paragraph. Count letters (not numbers or
// punctuation); leave scriptless text to the browser's normal `dir=auto`.
export type ProseDirection = "rtl" | "ltr" | "auto";

interface ScriptCounts {
  rtl: number;
  latin: number;
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Single-pass script matcher: group 1 matches Arabic/Hebrew letters, group 2 matches Latin letters.
const SCRIPT_LETTER = /([\p{Script=Arabic}\p{Script=Hebrew}])|(\p{Script=Latin})/gu;
const AUTOLINK_LABEL = /^(?:https?:\/\/|www\.|file:\/\/|mailto:)[^\s]+$/i;
const DIRECTION_BLOCKS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "blockquote", "th", "td",
]);

// Cap the sample scanned on huge strings (e.g. multi-MB log dumps in SafeMarkdownBody)
// so direction detection stays sub-millisecond on the main thread.
const MAX_PROSE_SAMPLE_CHARS = 4096;
const MAX_COMPOSER_SAMPLE_CHARS = 8192;

let lastProseInput: string | null = null;
let lastProseOutput: ProseDirection = "auto";

let lastComposerInput: string | null = null;
let lastComposerOutput: ProseDirection = "auto";

export function directionFromCounts(rtl: number, latin: number): ProseDirection {
  // Ties in mixed prose prefer RTL in this Persian presentation overlay.
  if (rtl && rtl >= latin) return "rtl";
  if (latin) return "ltr";
  return "auto";
}

export function countScripts(text: string, maxChars = MAX_PROSE_SAMPLE_CHARS): ScriptCounts {
  if (!text) return { rtl: 0, latin: 0 };
  const sample = text.length > maxChars ? text.slice(0, maxChars) : text;
  let rtl = 0;
  let latin = 0;
  SCRIPT_LETTER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_LETTER.exec(sample)) !== null) {
    if (match[1] !== undefined) rtl++;
    else latin++;
  }
  // Fallback if the leading 4 KB was pure numbers/whitespace/punctuation in a huge string.
  if (rtl === 0 && latin === 0 && text.length > maxChars) {
    const extended = text.slice(maxChars, maxChars * 8);
    SCRIPT_LETTER.lastIndex = 0;
    while ((match = SCRIPT_LETTER.exec(extended)) !== null) {
      if (match[1] !== undefined) rtl++;
      else latin++;
    }
  }
  return { rtl, latin };
}

export function proseDirection(text: string): ProseDirection {
  if (text === lastProseInput) return lastProseOutput;
  const { rtl, latin } = countScripts(text, MAX_PROSE_SAMPLE_CHARS);
  const result = directionFromCounts(rtl, latin);
  lastProseInput = text;
  lastProseOutput = result;
  return result;
}

export function composerDirection(text: string): ProseDirection {
  if (text === lastComposerInput) return lastComposerOutput;
  // A leading ! is Pi's shell-command input, not prose; don't move its caret
  // and command text to the right because of a Persian argument or comment.
  if (/^\s*!/.test(text)) {
    lastComposerInput = text;
    lastComposerOutput = "ltr";
    return "ltr";
  }
  const sample = text.length > MAX_COMPOSER_SAMPLE_CHARS
    ? text.slice(0, MAX_COMPOSER_SAMPLE_CHARS)
    : text;
  // A URL, a code span, or a fenced block at the start should not decide the
  // direction of the surrounding prose while the user is drafting Markdown.
  const withoutCode = sample
    .replace(/```[^\n]*\n[\s\S]*?```/g, " ")
    .replace(/`+[^`\n]*`+/g, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, " ");
  const { rtl, latin } = countScripts(withoutCode, MAX_PROSE_SAMPLE_CHARS);
  const result = directionFromCounts(rtl, latin);
  lastComposerInput = text;
  lastComposerOutput = result;
  return result;
}

function extractNodeText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "element") {
    if (node.tagName === "code" || node.tagName === "pre" || node.tagName === "math") return "";
    return (node.children ?? []).map(extractNodeText).join("");
  }
  return "";
}

/**
 * Single-pass bottom-up HAST visitor that assigns `dir` to each prose block and
 * list without re-traversing nested subtrees or concatenating duplicate strings.
 */
export function rehypeProseDirection() {
  return (tree: HastNode) => {
    const visit = (node: HastNode): ScriptCounts => {
      if (node.type === "text") {
        return countScripts(node.value ?? "", MAX_PROSE_SAMPLE_CHARS);
      }
      if (node.type === "element") {
        const tag = node.tagName ?? "";
        if (tag === "pre" || tag === "code") {
          node.properties ??= {};
          node.properties.dir = "ltr";
          return { rtl: 0, latin: 0 };
        }
        if (tag === "math") {
          return { rtl: 0, latin: 0 };
        }

        let rtl = 0;
        let latin = 0;
        let rtlItems = 0;
        let ltrItems = 0;
        const isList = tag === "ul" || tag === "ol";

        for (const child of node.children ?? []) {
          const childCounts = visit(child);
          rtl += childCounts.rtl;
          latin += childCounts.latin;
          if (isList && child.type === "element" && child.tagName === "li") {
            const itemDir = child.properties?.dir;
            if (itemDir === "rtl") rtlItems++;
            else if (itemDir === "ltr") ltrItems++;
          }
        }

        if (tag === "a") {
          const label = extractNodeText(node).trim();
          if (AUTOLINK_LABEL.test(label)) {
            return { rtl: 0, latin: 0 };
          }
          return { rtl, latin };
        }

        if (isList) {
          node.properties ??= {};
          // A long English item must not put the markers of two Persian items
          // on the left. Count the immediate items, not their combined length.
          node.properties.dir = rtlItems
            ? (rtlItems >= ltrItems ? "rtl" : "ltr")
            : (ltrItems ? "ltr" : "auto");
        } else if (DIRECTION_BLOCKS.has(tag)) {
          node.properties ??= {};
          node.properties.dir = directionFromCounts(rtl, latin);
        }
        return { rtl, latin };
      }

      let rtl = 0;
      let latin = 0;
      for (const child of node.children ?? []) {
        const childCounts = visit(child);
        rtl += childCounts.rtl;
        latin += childCounts.latin;
      }
      return { rtl, latin };
    };

    visit(tree);
  };
}
