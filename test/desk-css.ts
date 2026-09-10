import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");

/** The three sheets app.css already imported before it became an index. */
const ALREADY_SPLIT = ["tokens.css", "crew-tray.css", "horse-status.css"];

/**
 * The desk stylesheet as the browser assembles it. `app.css` is an index of
 * surface files now, so a suite that reads it alone reads nothing but imports.
 * Concatenating in import order gives the same text, and the same cascade,
 * the one file used to hold.
 *
 * CRLF normalised here rather than at each call site. A suite that slices this
 * text at a literal `\n` gets -1 from `indexOf` on a Windows checkout, and
 * fifteen suites read the sheet through this one function.
 */
export function deskCss(): string {
  const index = readFileSync(path.join(STYLES, "app.css"), "utf8");
  return [...index.matchAll(/@import "\.\/([^"]+)";/g)]
    .map((match) => match[1]!)
    .filter((name) => !ALREADY_SPLIT.includes(name))
    .map((name) => readFileSync(path.join(STYLES, name), "utf8"))
    .join("")
    .replace(/\r\n/g, "\n");
}
