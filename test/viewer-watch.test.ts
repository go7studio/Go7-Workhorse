import assert from "node:assert";
import { test, describe } from "node:test";
import {
  watchViewerFolder,
  viewerWatchFolder,
  viewerRendersFolder,
  type ViewerFileEvent,
} from "../electron/viewer-watch";

describe("viewerWatchFolder paths", () => {
  test("returns correct path for project root", () => {
    const folder = viewerWatchFolder("/projects/myproject");
    assert.strictEqual(folder, "/projects/myproject/.workhorse/env/blender");
  });

  test("viewerRendersFolder returns renders subfolder", () => {
    const folder = viewerRendersFolder("/projects/myproject");
    assert.strictEqual(folder, "/projects/myproject/.workhorse/env/blender/renders");
  });
});

describe("watchViewerFolder", () => {
  const mockWatch = () =>
    ({
      on: () => {},
      close: () => {},
    }) as unknown as ReturnType<typeof import("node:fs").watch>;

  test("returns handle with stop and idle methods", () => {
    const events: ViewerFileEvent[] = [];
    const handle = watchViewerFolder({
      folder: "/nonexistent/test/folder",
      onFile: (event) => events.push(event),
      existsSync: () => false,
      readdirSync: () => [],
      statSync: () => ({ mtimeMs: Date.now() }),
      readFileSync: () => Buffer.from(""),
    });

    assert.ok(typeof handle.stop === "function");
    assert.ok(typeof handle.idle === "function");
    handle.stop();
  });

  test("returns empty handle for empty folder path", () => {
    const handle = watchViewerFolder({
      folder: "",
      onFile: () => {},
    });

    handle.stop();
    assert.ok(true);
  });

  test("initial scan detects existing files", async () => {
    const events: ViewerFileEvent[] = [];
    const files = ["model.glb", "render.png", "data.txt"];
    const mtimes = new Map<string, number>([
      ["/test/model.glb", 1000],
      ["/test/render.png", 2000],
    ]);

    const handle = watchViewerFolder({
      folder: "/test",
      onFile: (event) => events.push(event),
      existsSync: (p) => p === "/test" || files.some((f) => p.endsWith(f)),
      readdirSync: () => files,
      statSync: (p) => ({ mtimeMs: mtimes.get(p) ?? 0 }),
      readFileSync: (p) => Buffer.from(p),
      watch: mockWatch,
    });

    await handle.idle();

    const glbEvent = events.find((e) => e.path.endsWith("model.glb"));
    const pngEvent = events.find((e) => e.path.endsWith("render.png"));
    const txtEvent = events.find((e) => e.path.endsWith("data.txt"));

    assert.ok(glbEvent, "should detect GLB file");
    assert.strictEqual(glbEvent?.type, "added");
    assert.strictEqual(glbEvent?.format, "glb");

    assert.ok(pngEvent, "should detect PNG file");
    assert.strictEqual(pngEvent?.type, "added");
    assert.strictEqual(pngEvent?.format, "png");

    assert.ok(!txtEvent, "should ignore non-viewer files");

    handle.stop();
  });

  test("detects GLTF files", async () => {
    const events: ViewerFileEvent[] = [];

    const handle = watchViewerFolder({
      folder: "/test",
      onFile: (event) => events.push(event),
      existsSync: () => true,
      readdirSync: () => ["scene.gltf"],
      statSync: () => ({ mtimeMs: Date.now() }),
      readFileSync: () => Buffer.from("gltf content"),
      watch: mockWatch,
    });

    await handle.idle();

    const gltfEvent = events.find((e) => e.path.endsWith("scene.gltf"));
    assert.ok(gltfEvent);
    assert.strictEqual(gltfEvent?.format, "gltf");

    handle.stop();
  });

  test("detects JPG files with both extensions", async () => {
    const events: ViewerFileEvent[] = [];

    const handle = watchViewerFolder({
      folder: "/test",
      onFile: (event) => events.push(event),
      existsSync: () => true,
      readdirSync: () => ["photo.jpg", "image.jpeg"],
      statSync: () => ({ mtimeMs: Date.now() }),
      readFileSync: () => Buffer.from("jpg content"),
      watch: mockWatch,
    });

    await handle.idle();

    assert.strictEqual(events.length, 2);
    assert.ok(events.every((e) => e.format === "jpg"));

    handle.stop();
  });

  test("stop() prevents further events", async () => {
    const events: ViewerFileEvent[] = [];

    const handle = watchViewerFolder({
      folder: "/test",
      onFile: (event) => events.push(event),
      existsSync: () => true,
      readdirSync: () => [],
      statSync: () => ({ mtimeMs: Date.now() }),
      readFileSync: () => Buffer.from(""),
      watch: mockWatch,
    });

    handle.stop();

    const countBefore = events.length;
    await handle.idle();
    assert.strictEqual(events.length, countBefore);
  });
});
