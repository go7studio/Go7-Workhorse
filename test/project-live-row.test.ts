import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { projectLiveLine } from "../src/lib/sidebar-index";
import type { ChatLink } from "../src/lib/tool-labels";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const chat = (id: string, workers: string[] = []) => ({ id, workers: workers.map((worker) => ({ id: worker })) });
const link = (sessionId: string, label: string, kind: ChatLink["kind"] = "answering"): ChatLink => ({ sessionId, label, kind });

test("a project with one linked chat lends that chat's own line", () => {
  const links = new Map([["c1", link("c1", "Answering Independent adversarial review")]]);
  assert.deepEqual(projectLiveLine([chat("c1"), chat("c2")], links), {
    label: "Answering Independent adversarial review",
    count: 1,
  });
});

test("a project with several linked chats counts them instead of picking one", () => {
  const links = new Map([
    ["c1", link("c1", "Answering A")],
    ["c2", link("c2", "Being read by B", "reading")],
  ]);
  assert.deepEqual(projectLiveLine([chat("c1"), chat("c2"), chat("c3")], links), { label: "2 live chats", count: 2 });
});

test("a worker's call counts for the project through its parent", () => {
  const links = new Map([["w1", link("w1", "Called from Planner", "calling")]]);
  assert.deepEqual(projectLiveLine([chat("c1", ["w1"])], links), { label: "Called from Planner", count: 1 });
});

test("a project with nothing in a call shows nothing", () => {
  assert.equal(projectLiveLine([chat("c1"), chat("c2", ["w1"])], new Map()), undefined);
  const elsewhere = new Map([["other", link("other", "Answering X")]]);
  assert.equal(projectLiveLine([chat("c1")], elsewhere), undefined);
});

test("the folder wears the same peer bar and line the chat row wears", () => {
  const sidebar = read("src/ui/Sidebar.tsx");
  assert.match(sidebar, /projectLiveLine\(chats, index\.linksBySession\)/, "the folder asks the one rule");
  assert.match(sidebar, /\$\{live \? " live" : ""\}/, "the folder carries a live class");
  assert.match(sidebar, /live && !open \? <span className="row-meta peer">\{live\.label\}<\/span>/, "the line shows only while closed");
  const css = read("src/styles/app.css");
  assert.match(css, /\.project-folder\.live \.project-head \{\s*box-shadow: inset 3px 0 0 var\(--peer\);/, "same inset bar as .chat-row.peer-link");
  assert.match(css, /\.project-head \.row-meta\.peer \{\s*color: var\(--peer\);/, "same peer colour on the line");
});
