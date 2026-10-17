import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, describe } from "node:test";
import { resolveMediaProtocolFile } from "../electron/media-src";
import { mediaUrlToPath } from "../src/lib/media-display";
import {
  buildAnnotation,
  isValidAnnotation,
  formatAnnotationForModel,
  formatMarksForChat,
  previewAsset,
  previewFormat,
  viewerResourceUrl,
  viewerRenderUrl,
  nextAnnotationMark,
  blenderToGltf,
  gltfToBlender,
  type Annotation,
} from "../src/lib/viewer";

describe("viewer annotation schema", () => {
  test("buildAnnotation creates valid annotation", () => {
    const annotation = buildAnnotation({
      id: "test-id-123",
      chatId: "chat-456",
      kind: "3d-point",
      note: "fix this spot",
      mark: 1,
      asset: {
        uri: "model.glb",
        format: "glb",
      },
      target: {
        objectName: "Cube",
        objectPath: "Scene/Cube",
        worldPoint: [1.5, 2.0, -0.5],
        localPoint: [0.5, 1.0, -0.25],
        worldNormal: [0, 1, 0],
        faceIndex: 42,
        faceIndexSpace: "glTF triangle",
        distance: 3.5,
      },
      camera: {
        position: [3, 3, 3],
        quaternion: [0, 0, 0, 1],
        fovDeg: 45,
        viewport: [800, 600],
      },
      screenPx: [400, 300],
    });

    assert.strictEqual(annotation.schema, "workhorse.annotation/v0");
    assert.strictEqual(annotation.id, "test-id-123");
    assert.strictEqual(annotation.chatId, "chat-456");
    assert.strictEqual(annotation.kind, "3d-point");
    assert.strictEqual(annotation.note, "fix this spot");
    assert.strictEqual(annotation.mark, 1);
    assert.strictEqual(annotation.asset.uri, "model.glb");
    assert.strictEqual(annotation.asset.format, "glb");
    assert.deepStrictEqual(annotation.target?.worldPoint, [1.5, 2.0, -0.5]);
    assert.deepStrictEqual(annotation.screen?.px, [400, 300]);
    assert.ok(annotation.createdAt);
  });

  test("buildAnnotation handles 2d-point without target", () => {
    const annotation = buildAnnotation({
      id: "test-2d",
      chatId: "chat-2d",
      kind: "2d-point",
      note: "highlight here",
      mark: 2,
      asset: {
        uri: "render.png",
        format: "png",
      },
      region2d: {
        imageSize: [1920, 1080],
        px: [960, 540],
      },
      camera: {
        position: [0, 0, 1],
        quaternion: [0, 0, 0, 1],
        fovDeg: 0,
        viewport: [1920, 1080],
      },
      screenPx: [960, 540],
    });

    assert.strictEqual(annotation.kind, "2d-point");
    assert.ok(!annotation.target);
    assert.deepStrictEqual(annotation.region2d?.imageSize, [1920, 1080]);
    assert.deepStrictEqual(annotation.region2d?.px, [960, 540]);
  });

  test("isValidAnnotation accepts valid annotation", () => {
    const valid: Annotation = {
      schema: "workhorse.annotation/v0",
      id: "abc123",
      createdAt: new Date().toISOString(),
      chatId: "chat-id",
      kind: "3d-point",
      note: "test",
      mark: 1,
      asset: { uri: "test.glb", format: "glb" },
      camera: {
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        fovDeg: 45,
        viewport: [800, 600],
      },
    };
    assert.ok(isValidAnnotation(valid));
  });

  test("isValidAnnotation rejects invalid objects", () => {
    assert.ok(!isValidAnnotation(null));
    assert.ok(!isValidAnnotation(undefined));
    assert.ok(!isValidAnnotation({}));
    assert.ok(!isValidAnnotation({ schema: "wrong" }));
    assert.ok(!isValidAnnotation({ schema: "workhorse.annotation/v0" }));
    assert.ok(
      !isValidAnnotation({
        schema: "workhorse.annotation/v0",
        id: "test",
        chatId: "chat",
        kind: "3d-point",
        mark: 1,
      })
    );
  });

  test("formatAnnotationForModel produces readable output", () => {
    const annotation: Annotation = {
      schema: "workhorse.annotation/v0",
      id: "format-test",
      createdAt: new Date().toISOString(),
      chatId: "chat",
      kind: "3d-point",
      note: "make this bigger",
      mark: 3,
      asset: { uri: "duck.glb", format: "glb" },
      target: {
        objectName: "Duck",
        objectPath: "Scene/Duck",
        worldPoint: [0.5, 1.0, -0.25],
        worldNormal: [0, 1, 0],
        faceIndex: 100,
        faceIndexSpace: "glTF triangle",
        distance: 2.5,
      },
      camera: {
        position: [2, 2, 2],
        quaternion: [0, 0, 0, 1],
        fovDeg: 45,
        viewport: [800, 600],
      },
    };

    const output = formatAnnotationForModel(annotation);
    assert.ok(output.includes("[Pin 3]"));
    assert.ok(output.includes("make this bigger"));
    assert.ok(output.includes("Scene/Duck"));
    assert.ok(output.includes("Point (glTF Y-up)"));
    assert.ok(output.includes("Z-up"));
    assert.equal(output.includes("Blender"), false);
  });

  test("formatAnnotationForModel handles missing note", () => {
    const annotation: Annotation = {
      schema: "workhorse.annotation/v0",
      id: "no-note",
      createdAt: new Date().toISOString(),
      chatId: "chat",
      kind: "3d-point",
      note: "",
      mark: 1,
      asset: { uri: "test.glb", format: "glb" },
      target: {
        objectName: "Test",
        objectPath: "Test",
        worldPoint: [0, 0, 0],
      },
      camera: {
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        fovDeg: 45,
        viewport: [800, 600],
      },
    };

    const output = formatAnnotationForModel(annotation);
    assert.ok(output.includes("(no note)"));
  });
});

describe("marks for the chat", () => {
  test("a pin names the file and leaves the tool open", () => {
    const annotation = buildAnnotation({
      id: "pin-1",
      chatId: "chat",
      kind: "3d-point",
      note: "shorten this edge",
      mark: 1,
      asset: { uri: "part.glb", format: "glb" },
      target: {
        objectName: "Bracket",
        objectPath: "Scene/Bracket",
        worldPoint: [1, 2, 3],
      },
      camera: {
        position: [0, 0, 1],
        quaternion: [0, 0, 0, 1],
        fovDeg: 45,
        viewport: [800, 600],
      },
      screenPx: [10, 20],
    });
    const output = formatMarksForChat({
      filePath: "/work/part.glb",
      format: "glb",
      annotations: [annotation],
      note: "keep the holes",
    });
    assert.ok(output.includes("File: /work/part.glb (glb)"));
    assert.ok(output.includes("shorten this edge"));
    assert.ok(output.includes("Note: keep the holes"));
    assert.ok(output.includes("Pick the tool"));
    assert.equal(output.includes("Blender"), false);
  });

  test("a drawable file uses a media address the desk can fetch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-preview-url-"));
    const file = path.join(dir, "part.glb");
    fs.writeFileSync(file, "glb");
    const asset = previewAsset(file, "glb");
    assert.match(asset.uri, /^workhorse-media:/);
    assert.equal(mediaUrlToPath(asset.uri), file);
    assert.equal(resolveMediaProtocolFile(asset.uri), file);
    assert.equal(previewAsset(file, "file").uri, file);
  });

  test("a CAD file still goes to the chat", () => {
    assert.equal(previewFormat("/work/bracket.glb"), "glb");
    assert.equal(previewFormat("/work/photo.JPEG"), "jpg");
    assert.equal(previewFormat("/work/bracket.step"), "file");
    const output = formatMarksForChat({
      filePath: "/work/bracket.step",
      format: "file",
      annotations: [],
    });
    assert.ok(output.includes("File: /work/bracket.step (file)"));
    assert.equal(output.includes("Blender"), false);
  });
});

describe("coordinate conversion", () => {
  test("blenderToGltf converts Z-up to Y-up", () => {
    const [x, y, z] = blenderToGltf([1, 2, 3]);
    assert.strictEqual(x, 1);
    assert.strictEqual(y, 3);
    assert.strictEqual(z, -2);
  });

  test("gltfToBlender converts Y-up to Z-up", () => {
    const [x, y, z] = gltfToBlender([1, 3, -2]);
    assert.strictEqual(x, 1);
    assert.strictEqual(y, 2);
    assert.strictEqual(z, 3);
  });

  test("round-trip conversion preserves coordinates", () => {
    const original: [number, number, number] = [1.5, 2.5, -3.5];
    const converted = blenderToGltf(original);
    const restored = gltfToBlender(converted);
    assert.deepStrictEqual(restored, original);
  });

  test("handles origin correctly", () => {
    const blenderResult = blenderToGltf([0, 0, 0]);
    assert.strictEqual(blenderResult[0], 0);
    assert.strictEqual(blenderResult[1], 0);
    assert.strictEqual(Math.abs(blenderResult[2]), 0);
    
    const gltfResult = gltfToBlender([0, 0, 0]);
    assert.strictEqual(gltfResult[0], 0);
    assert.strictEqual(Math.abs(gltfResult[1]), 0);
    assert.strictEqual(gltfResult[2], 0);
  });
});

describe("annotation payload matches prototype schema", () => {
  test("payload structure matches payloads.json duck example", () => {
    const annotation = buildAnnotation({
      id: "duck-test",
      chatId: "test-chat",
      kind: "3d-point",
      note: "make the beak longer here",
      mark: 1,
      asset: {
        uri: "Duck.glb",
        format: "glb",
      },
      target: {
        objectName: "LOD3spShape",
        objectPath: "Group/Object3D/LOD3spShape",
        uuid: "10df2fd5-da45-4eab-a78e-26ae8c79c6f7",
        faceIndex: 2310,
        faceIndexSpace: "glTF triangle",
        worldPoint: [0.8947, 0.6111, -0.0385],
        localPoint: [83.4736, 129.2288, -8.1407],
        worldNormal: [-0.3047, 0.7011, 0.6446],
        uv: [0.9049, 0.7513],
        distance: 3.629,
      },
      camera: {
        position: [2.2, 1.6, 3.2],
        quaternion: [-0.12, 0.2943, 0.0373, 0.9474],
        fovDeg: 45,
        viewport: [800, 600],
      },
      screenPx: [555, 322],
    });

    assert.strictEqual(annotation.schema, "workhorse.annotation/v0");
    assert.strictEqual(annotation.kind, "3d-point");
    assert.strictEqual(annotation.note, "make the beak longer here");
    assert.strictEqual(annotation.asset.uri, "Duck.glb");
    assert.strictEqual(annotation.target?.objectName, "LOD3spShape");
    assert.strictEqual(annotation.target?.faceIndex, 2310);
    assert.deepStrictEqual(annotation.target?.worldPoint, [0.8947, 0.6111, -0.0385]);
    assert.deepStrictEqual(annotation.camera?.position, [2.2, 1.6, 3.2]);
    assert.deepStrictEqual(annotation.screen?.px, [555, 322]);
  });

  test("payload structure matches payloads.json crate example", () => {
    const annotation = buildAnnotation({
      id: "crate-test",
      chatId: "test-chat",
      kind: "3d-point",
      note: "chip this corner",
      mark: 2,
      asset: {
        uri: "Duck.glb",
        format: "glb",
      },
      target: {
        objectName: "Crate",
        objectPath: "Crate",
        uuid: "0d5cec77-ff89-41e5-a95c-696c415c6287",
        faceIndex: 9,
        faceIndexSpace: "glTF triangle",
        worldPoint: [-0.9015, 0.0294, 0.3],
        localPoint: [0.1985, -0.2706, 0.3],
        worldNormal: [0, 0, 1],
        uv: [0.8309, 0.049],
        distance: 4.5272,
      },
      camera: {
        position: [2.2, 1.6, 3.2],
        quaternion: [-0.12, 0.2943, 0.0373, 0.9474],
        fovDeg: 45,
        viewport: [800, 600],
      },
      screenPx: [250, 380],
    });

    assert.strictEqual(annotation.target?.objectName, "Crate");
    assert.strictEqual(annotation.target?.faceIndex, 9);
    assert.deepStrictEqual(annotation.target?.worldNormal, [0, 0, 1]);
    assert.deepStrictEqual(annotation.screen?.px, [250, 380]);
  });
});


describe("preview refresh and local dependencies", () => {
  const asset = { ...previewAsset("/project/preview/model.gltf", "gltf"), loadedAt: 17, scopeRoot: "/project" };
  test("reload changes render bytes without changing saved pin identity", () => {
    assert.notEqual(viewerRenderUrl(asset), viewerRenderUrl({ ...asset, loadedAt: 18 }));
    assert.equal(asset.uri.includes("revision"), false);
  });
  test("glTF resolves buffers and parent textures under its media scope", () => {
    const buffer = new URL(viewerResourceUrl(asset, "workhorse-preview-resource://local/model.bin"));
    assert.equal(buffer.searchParams.get("p"), "/project/preview/model.bin");
    assert.equal(buffer.searchParams.get("cwd"), "/project");
    assert.equal(buffer.searchParams.get("revision"), "17");
    const texture = new URL(viewerResourceUrl(asset, "workhorse-preview-resource://local/../textures/blue%20one.png"));
    assert.equal(texture.searchParams.get("p"), "/project/textures/blue one.png");
    assert.equal(viewerResourceUrl(asset, "data:application/octet-stream;base64,AA=="), "data:application/octet-stream;base64,AA==");
    assert.throws(() => viewerResourceUrl(asset, "https://example.com/model.bin"), /local files/);
    assert.throws(() => viewerResourceUrl(asset, "workhorse-preview-resource://local/../../outside.bin"), /outside the project/);
    assert.throws(() => viewerResourceUrl(asset, "workhorse-media://local/?p=%2Foutside.bin"), /relative paths/);
    for (const folder of ["model #2", "100% done"]) {
      const special = { ...asset, ...previewAsset(`/project/${folder}/model.gltf`, "gltf") };
      assert.equal(new URL(viewerResourceUrl(special, "workhorse-preview-resource://local/mesh.bin")).searchParams.get("p"), `/project/${folder}/mesh.bin`);
    }
  });
  test("new pins follow the highest persisted mark for this asset", () => {
    const annotations = [{ mark: 4, asset: { uri: asset.uri } }, { mark: 19, asset: { uri: "other" } }] as Annotation[];
    assert.equal(nextAnnotationMark(annotations, asset.uri), 5);
    assert.equal(nextAnnotationMark([], asset.uri), 1);
  });
});
