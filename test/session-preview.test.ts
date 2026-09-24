import assert from "node:assert/strict";
import test from "node:test";
import { chatPreview, collapsePreviewLabel } from "../src/lib/session-bridge";
import { buildDeskContext } from "../src/lib/context-preface";

test("collapsePreviewLabel strips a leading run of Preview:", () => {
  assert.equal(collapsePreviewLabel("Preview: Preview: hello"), "hello");
  assert.equal(collapsePreviewLabel("  preview:  task done  "), "task done");
});

test("a second preview computation does not lengthen a snippet that already starts with Preview: Preview:", () => {
  const messages = [{ role: "assistant", text: "Preview: Preview: ship the fix" }];
  const first = chatPreview(messages);
  const second = chatPreview([{ role: "assistant", text: first }]);
  assert.equal(first, second);
  assert.equal(first, "ship the fix");
  assert.equal(first.length, "ship the fix".length);
});

test("buildDeskContext does not double-label an echoed preview prefix", () => {
  const desk = buildDeskContext({
    title: "Preview check",
    sidebar: "Grok · Ask",
    preview: "Preview: Preview: last turn",
  });
  assert.match(desk, /Preview \(last message snippet\): last turn/);
  assert.doesNotMatch(desk, /Preview: Preview:/);
});
