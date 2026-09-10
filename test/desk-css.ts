import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");

/** The three sheets app.css already imported before it became an index. */
const ALREADY_SPLIT = ["tokens.css", "crew-tray.css", "horse-status.css"];

/**
 * The surface sheets `app.css` names, in the order it imports them, which is
 * the order the cascade reads them in.
 *
 * CRLF normalised here rather than at each call site. A suite that slices this
 * text at a literal `\n` gets -1 from `indexOf` on a Windows checkout, and
 * fifteen suites read the sheet through this one module.
 */
export function deskSheets(): { name: string; css: string }[] {
  const index = readFileSync(path.join(STYLES, "app.css"), "utf8");
  return [...index.matchAll(/@import "\.\/([^"]+)";/g)]
    .map((match) => match[1]!)
    .filter((name) => !ALREADY_SPLIT.includes(name))
    .map((name) => ({
      name,
      css: readFileSync(path.join(STYLES, name), "utf8").replace(/\r\n/g, "\n"),
    }));
}

/**
 * The desk stylesheet as the browser assembles it. `app.css` is an index of
 * surface files now, so a suite that reads it alone reads nothing but imports.
 * Concatenating in import order gives the same text, and the same cascade,
 * the one file used to hold.
 */
export function deskCss(): string {
  return deskSheets()
    .map((sheet) => sheet.css)
    .join("");
}

/** One rule as the cascade sees it: what it sits under, what it names, what it sets. */
export type Rule = { at: string; selector: string; declarations: string };

/** At-rules that wrap other rules. `@keyframes` does not: its body is the rule. */
const WRAPS_RULES = /^@(?:media|supports|container|layer|scope)\b/;

/** Whitespace collapsed, so reformatting a rule is not the same as changing it. */
function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Every rule in a stylesheet, in source order, each carrying the at-rule it
 * sits under. The context has to travel with the selector: `.chat-row` inside
 * `@media (max-width: 720px)` is not the same rule as `.chat-row` outside it,
 * and eighteen media blocks in this sheet redeclare selectors on purpose.
 *
 * Comments go first. A rule that gained an explaining comment did not change.
 */
export function cssRules(css: string): Rule[] {
  const rules: Rule[] = [];

  const read = (body: string, at: string) => {
    let prelude = "";
    for (let i = 0; i < body.length; i += 1) {
      const char = body[i]!;
      if (char === "{") {
        let depth = 1;
        let end = i + 1;
        while (end < body.length && depth > 0) {
          if (body[end] === "{") depth += 1;
          else if (body[end] === "}") depth -= 1;
          end += 1;
        }
        const inner = body.slice(i + 1, end - 1);
        const head = tidy(prelude);
        if (WRAPS_RULES.test(head)) read(inner, at ? `${at} ${head}` : head);
        else rules.push({ at, selector: head, declarations: tidy(inner) });
        prelude = "";
        i = end - 1;
      } else if (char === ";") {
        prelude = ""; // `@import` and friends: a statement, not a block
      } else {
        prelude += char;
      }
    }
  };

  read(css.replace(/\/\*[\s\S]*?\*\//g, " "), "");
  return rules;
}

/** What a rule is called, context included, so two sheets cannot both claim it. */
export function ruleKey(rule: Rule): string {
  return rule.at ? `${rule.at} { ${rule.selector}` : rule.selector;
}
