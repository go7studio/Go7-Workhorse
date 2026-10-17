/**
 * Opens an isolated Workhorse window, loads a real GLB in the preview,
 * clicks the model and a PNG, and checks To chat then Send for both.
 *
 * Send goes to a local mock on 127.0.0.1, not a paid vendor. The mock records
 * the chat-completions body. The last user message must carry the marks.
 *
 *   WORKHORSE_PREVIEW_SMOKE=1 npx tsx test/preview-window-smoke.ts
 *
 * The desk uses its own userData. The installed app is left alone.
 * Build the tree first: npx vite build
 */
import { _electron as electron } from "playwright";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { grokBotChatSse } from "../src/lib/grok-bot-shim";

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

/** A solid RGBA PNG large enough for a real click. */
function solidPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 4;
      raw[i] = 40;
      raw[i + 1] = 90;
      raw[i + 2] = 160;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

if (process.env.WORKHORSE_PREVIEW_SMOKE !== "1") {
  throw new Error("Set WORKHORSE_PREVIEW_SMOKE=1. This opens a window.");
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wh-preview-smoke-")));
const userData = path.join(root, "desk");
const project = path.join(root, "project");
const preview = path.join(project, ".workhorse", "preview");
fs.mkdirSync(preview, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const glb = path.join(preview, "probe.glb");
const maker = path.join(root, "make.py");
fs.writeFileSync(
  maker,
  [
    "import bpy, os",
    "bpy.ops.wm.read_factory_settings(use_empty=True)",
    "bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))",
    "bpy.context.active_object.name = 'TestCube'",
    `bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb)}, export_format='GLB')`,
    "print('EXPORT_OK')",
    "",
  ].join("\n"),
);
const made = spawnSync("blender", ["-b", "--python", maker], { encoding: "utf8" });
if (made.status !== 0 || !fs.existsSync(glb)) {
  throw new Error(made.stderr || made.stdout || "Blender did not write the GLB");
}

const relayed: string[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (req.method === "POST") relayed.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(grokBotChatSse("relay-1", "Got the marks."));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const bound = server.address();
if (!bound || typeof bound === "string") throw new Error("relay server has no port");
const relayPort = bound.port;

function lastUserText(raw: string): string {
  const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }> };
  const users = (parsed.messages ?? []).filter((message) => message.role === "user");
  const content = users.at(-1)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
    .join("\n");
}

const now = Date.now();
fs.writeFileSync(
  path.join(userData, "workhorse-state.json"),
  JSON.stringify({
    theme: "system",
    projects: [
      {
        id: "proj_preview_smoke",
        name: "Preview smoke",
        createdAt: now,
        openedAt: now,
        folders: [{ id: "fold_preview_smoke", path: project, label: "project" }],
        references: [],
      },
    ],
    sessions: [
      {
        id: "sess_preview_smoke",
        projectId: "proj_preview_smoke",
        provider: "custom",
        customBotId: "bot_preview_relay",
        model: "relay-local",
        effort: "medium",
        title: "Preview smoke",
        mode: "ask",
        sandbox: "off",
        status: "idle",
        messages: [],
        composerDraft: "Waiting for the preview.",
      },
    ],
    activeProjectId: "proj_preview_smoke",
    activeSessionId: "sess_preview_smoke",
    settings: {
      llms: {},
      access: { mode: "ask", sandbox: "off" },
      customBots: [
        {
          id: "bot_preview_relay",
          name: "Relay",
          color: "#5b8def",
          baseUrl: `http://127.0.0.1:${relayPort}/v1`,
          model: "relay-local",
          api: "openai-completions",
          apiKey: "relay-test-key",
          contextWindow: 32000,
          enabled: true,
          createdAt: now,
        },
      ],
    },
  }),
);

const app = await electron.launch({
  args: [".", "--no-sandbox"],
  cwd: process.cwd(),
  timeout: 60_000,
  env: {
    ...process.env,
    WORKHORSE_USER_DATA_PATH: userData,
    WORKHORSE_VOLATILE_CREDENTIALS: "1",
  },
});

const shot = path.join(root, "window.png");
const lines: string[] = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("console", (msg) => lines.push(`${msg.type()}: ${msg.text()}`));
  await page.getByRole("button", { name: "3D", exact: true }).click();
  const canvas = page.locator(".viewer-canvas");
  await canvas.waitFor({ state: "visible" });
  const loaded = await page.waitForFunction(() => {
    const node = document.querySelector(".viewer-canvas");
    const state = node?.getAttribute("data-model");
    return state === "loaded" || state === "error" ? state : false;
  }, null, { timeout: 20_000 });
  const modelState = await loaded.jsonValue();
  if (modelState !== "loaded") {
    const detail = await canvas.getAttribute("data-model-error");
    throw new Error(`model ${modelState || "missing"}: ${detail ?? ""}`);
  }
  await canvas.click();
  await page.getByText("1 pin").waitFor();
  await page.locator(".viewer-canvas .viewer-pin-label").filter({ hasText: /^1$/ }).waitFor();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const idleFrames = await canvas.getAttribute("data-render-count");
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (idleFrames !== await canvas.getAttribute("data-render-count")) throw new Error("the static 3D preview keeps rendering while idle");
  await page.locator(".viewer-note-input").fill("shorten this edge");
  await page.getByRole("button", { name: "To chat" }).click();
  const draft = page.locator("[data-composer-field='true']");
  await draft.waitFor({ state: "attached" });
  const text = await draft.inputValue();
  if (!text.includes(`File: ${glb} (glb)`)) throw new Error(`composer missed the file:\n${text}`);
  if (!text.includes("[Pin 1]")) throw new Error(`composer missed the pin:\n${text}`);
  if (!text.includes("shorten this edge")) throw new Error(`composer missed the note:\n${text}`);
  if (!text.includes("TestCube")) throw new Error(`composer missed the object:\n${text}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = page.locator("article.turn.user").filter({ hasText: "TestCube" });
  await sent.waitFor();
  const visible = await sent.innerText();
  if (!visible.includes(`File: ${glb} (glb)`)) throw new Error(`chat missed the file:\n${visible}`);
  if (!visible.includes("[Pin 1]")) throw new Error(`chat missed the pin:\n${visible}`);
  if (!visible.includes("shorten this edge")) throw new Error(`chat missed the note:\n${visible}`);
  const deadline = Date.now() + 20_000;
  while (relayed.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (relayed.length === 0) throw new Error("the model received no request");
  const handed = lastUserText(relayed[0] ?? "");
  if (!handed.includes(`File: ${glb} (glb)`)) throw new Error(`model missed the file:\n${handed.slice(0, 1500)}`);
  if (!handed.includes("[Pin 1]")) throw new Error(`model missed the pin:\n${handed.slice(0, 1500)}`);
  if (!handed.includes("shorten this edge")) throw new Error(`model missed the note:\n${handed.slice(0, 1500)}`);
  if (!handed.includes("TestCube")) throw new Error(`model missed the object:\n${handed.slice(0, 1500)}`);
  await page.locator("article.turn.assistant").filter({ hasText: "Got the marks." }).waitFor();
  const left = await draft.inputValue();
  if (left.includes("TestCube")) throw new Error("composer still holds the sent marks");

  const still = path.join(preview, "mark.png");
  fs.writeFileSync(still, solidPng(64, 64));
  await page.getByText("mark.png", { exact: true }).waitFor();
  const image = page.locator(".viewer-image-container img");
  await image.waitFor({ state: "visible" });
  await page.getByText("Click to place pin 1", { exact: true }).waitFor();
  await image.click();
  await page.getByText("1 pin", { exact: true }).waitFor();
  await page.locator(".viewer-note-input").fill("raise this corner");
  await page.getByRole("button", { name: "To chat" }).click();
  await page.waitForFunction(
    (file) => {
      const field = document.querySelector("[data-composer-field='true']");
      return field instanceof HTMLTextAreaElement && field.value.includes(file);
    },
    `File: ${still} (png)`,
  );
  const stillDraft = await draft.inputValue();
  if (!stillDraft.includes("[Pin 1]")) throw new Error(`png composer missed the pin:\n${stillDraft}`);
  if (!stillDraft.includes("Image point:")) throw new Error(`png composer missed the image point:\n${stillDraft}`);
  if (!stillDraft.includes("raise this corner")) throw new Error(`png composer missed the note:\n${stillDraft}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const stillSent = page.locator("article.turn.user").filter({ hasText: "mark.png" });
  await stillSent.waitFor();
  const stillVisible = await stillSent.innerText();
  if (!stillVisible.includes(`File: ${still} (png)`)) throw new Error(`chat missed the still:\n${stillVisible}`);
  if (!stillVisible.includes("Image point:")) throw new Error(`chat missed the image point:\n${stillVisible}`);
  const stillDeadline = Date.now() + 20_000;
  while (relayed.length < 2 && Date.now() < stillDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (relayed.length < 2) throw new Error("the still was not handed to the model");
  const stillHanded = lastUserText(relayed[1] ?? "");
  if (!stillHanded.includes(`File: ${still} (png)`)) throw new Error(`model missed the still:\n${stillHanded.slice(0, 1500)}`);
  if (!stillHanded.includes("Image point:")) throw new Error(`model missed the image point:\n${stillHanded.slice(0, 1500)}`);
  if (!stillHanded.includes("raise this corner")) throw new Error(`model missed the still note:\n${stillHanded.slice(0, 1500)}`);
  console.log("PASS preview window");
  console.log(visible.split("\n").slice(0, 12).join("\n"));
  console.log("--- handed to the model ---");
  console.log(handed.split("\n").filter((line) => /File:|Note:|Pin|TestCube|Make the marked/.test(line)).join("\n"));
  console.log("--- still handed to the model ---");
  console.log(stillHanded.split("\n").filter((line) => /File:|Note:|Pin|Image point|Make the marked/.test(line)).join("\n"));
} catch (error) {
  const page = app.windows()[0];
  if (page) await page.screenshot({ path: shot }).catch(() => undefined);
  const pageText = page ? await page.locator("body").innerText().catch(() => "") : "";
  console.error(String(error));
  console.error(lines.join("\n"));
  console.error(pageText.slice(0, 1500));
  console.error(`screenshot ${shot}`);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
