import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseChatMarkdown } from "../src/lib/markdown";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a status list that repeats a label keeps every row", () => {
  // The facts rows were keyed by label. A reply that says "Status" twice gave
  // React two rows with one key, and it dropped or duplicated rows while the
  // reply streamed.
  const blocks = parseChatMarkdown("- **Status:** build ok\n- **Status:** tests failing\n- **Owner:** desk");
  assert.equal(blocks[0]?.type, "facts");
  if (blocks[0]?.type !== "facts") throw new Error("expected facts");
  assert.deepEqual(
    blocks[0].rows.map((row) => row.label),
    ["Status", "Status", "Owner"],
  );
  const body = readFileSync(path.join(ROOT, "src", "ui", "MessageBody.tsx"), "utf8");
  assert.doesNotMatch(body, /key=\{row\.label\}/);
  assert.match(body, /block\.rows\.map\(\(row, rowIndex\) =>[\s\S]{0,40}key=\{rowIndex\}/);
});
