import assert from "node:assert";
import path from "node:path";
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
    assert.strictEqual(folder, "/projects/myproject/.workhorse/preview");
  });

  test("stills share the preview folder so one watch is enough", () => {
    const folder = viewerRendersFolder("/projects/myproject");
    assert.strictEqual(folder, "/projects/myproject/.workhorse/preview");
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
    assert.strictEqual(glbEvent?.initial, true);
    assert.strictEqual(glbEvent?.format, "glb");

    assert.ok(pngEvent, "should detect PNG file");
    assert.strictEqual(pngEvent?.type, "added");
    assert.strictEqual(pngEvent?.format, "png");

    assert.ok(!txtEvent, "should ignore non-viewer files");

    handle.stop();
  });

  test("the first scan reports the newest drawn file first", async () => {
    const events: ViewerFileEvent[] = [];
    const files = ["old.glb", "mid.png", "scene.gltf", "new.jpg", "scene.svg", "model.fbx", "mesh.obj", "note.txt"];
    const file = (name: string) => path.join("/draw", name);
    const mtimes = new Map<string, number>([
      [file("old.glb"), 10],
      [file("mid.png"), 20],
      [file("scene.gltf"), 25],
      [file("new.jpg"), 30],
    ]);

    const handle = watchViewerFolder({
      folder: "/draw",
      onFile: (event) => events.push(event),
      existsSync: () => true,
      readdirSync: () => files,
      statSync: (item) => ({ mtimeMs: mtimes.get(item) ?? 0 }),
      readFileSync: () => Buffer.from("x"),
      watch: mockWatch,
    });

    await handle.idle();

    assert.deepStrictEqual(
      events.map((event) => path.basename(event.path)),
      ["new.jpg", "scene.gltf", "mid.png", "old.glb"],
    );
    assert.ok(events.every((event) => event.initial === true));
    assert.deepStrictEqual(events.map((event) => event.format), ["jpg", "gltf", "png", "glb"]);
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
