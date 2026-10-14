/**
 * 3D/2D viewer and annotation types for the Blender environment.
 * Schema: workhorse.annotation/v0 (matches prototype payloads.json).
 */

export type AnnotationKind = "3d-point" | "3d-region" | "2d-point" | "2d-rect" | "2d-lasso";

export type AnnotationTarget = {
  objectName: string;
  objectPath: string;
  sourceObjectName?: string;
  uuid?: string;
  faceIndex?: number;
  faceIndexSpace?: "glTF triangle";
  worldPoint: [number, number, number];
  localPoint?: [number, number, number];
  worldNormal?: [number, number, number];
  uv?: [number, number] | null;
  material?: string;
  distance?: number;
};

export type AnnotationRegion2d = {
  imageSize: [number, number];
  px?: [number, number];
  rect?: [number, number, number, number];
  polygon?: Array<[number, number]>;
};

export type AnnotationCamera = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fovDeg: number;
  viewport: [number, number];
  upAxis?: "Y" | "Z";
};

export type AnnotationAsset = {
  uri: string;
  format: "glb" | "gltf" | "obj" | "fbx" | "png" | "jpg";
  sha256?: string;
  sourceApp?: "blender" | "godot" | "unity" | "unreal";
  sourceFile?: string;
};

export type AnnotationScreenshot = {
  path: string;
  marks: string;
};

export type Annotation = {
  schema: "workhorse.annotation/v0";
  id: string;
  createdAt: string;
  chatId: string;
  kind: AnnotationKind;
  note: string;
  mark: number;
  asset: AnnotationAsset;
  target?: AnnotationTarget;
  region2d?: AnnotationRegion2d;
  camera?: AnnotationCamera;
  screen?: { px: [number, number] };
  screenshot?: AnnotationScreenshot;
};

export type ViewerAsset = {
  uri: string;
  format: "glb" | "gltf" | "png" | "jpg";
  loadedAt: number;
  /** Absolute path on the filesystem. */
  path: string;
};

export type ViewerState = {
  asset: ViewerAsset | null;
  annotations: Annotation[];
  pendingNote: string;
  cameraPosition?: [number, number, number];
  cameraQuaternion?: [number, number, number, number];
};

/** Blender glTF export is Z-up; three.js / glTF standard is Y-up. */
export function blenderToGltf(point: [number, number, number]): [number, number, number] {
  const [x, y, z] = point;
  return [x, z, -y];
}

export function gltfToBlender(point: [number, number, number]): [number, number, number] {
  const [x, y, z] = point;
  return [x, -z, y];
}

/** Build annotation JSON from raycast hit. */
export function buildAnnotation(input: {
  id: string;
  chatId: string;
  kind: AnnotationKind;
  note: string;
  mark: number;
  asset: AnnotationAsset;
  target?: Omit<AnnotationTarget, "worldPoint"> & { worldPoint: [number, number, number] };
  region2d?: AnnotationRegion2d;
  camera: AnnotationCamera;
  screenPx: [number, number];
}): Annotation {
  return {
    schema: "workhorse.annotation/v0",
    id: input.id,
    createdAt: new Date().toISOString(),
    chatId: input.chatId,
    kind: input.kind,
    note: input.note,
    mark: input.mark,
    asset: input.asset,
    ...(input.target ? { target: input.target } : {}),
    ...(input.region2d ? { region2d: input.region2d } : {}),
    camera: input.camera,
    screen: { px: input.screenPx },
  };
}

/** Format annotation for model context. */
export function formatAnnotationForModel(ann: Annotation): string {
  const lines: string[] = [];
  lines.push(`[Pin ${ann.mark}] ${ann.note || "(no note)"}`);
  if (ann.target) {
    lines.push(`  Object: ${ann.target.objectPath || ann.target.objectName}`);
    const [x, y, z] = ann.target.worldPoint;
    lines.push(`  World point (glTF Y-up): [${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)}]`);
    const blender = gltfToBlender(ann.target.worldPoint);
    lines.push(`  Blender coords (Z-up): [${blender[0].toFixed(4)}, ${blender[1].toFixed(4)}, ${blender[2].toFixed(4)}]`);
    if (ann.target.worldNormal) {
      const [nx, ny, nz] = ann.target.worldNormal;
      lines.push(`  Normal: [${nx.toFixed(4)}, ${ny.toFixed(4)}, ${nz.toFixed(4)}]`);
    }
  }
  if (ann.region2d?.rect) {
    const [rx, ry, rw, rh] = ann.region2d.rect;
    lines.push(`  2D rect: [${rx}, ${ry}, ${rw}x${rh}]`);
  }
  return lines.join("\n");
}

/** Validate annotation schema for tests. */
export function isValidAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.schema !== "workhorse.annotation/v0") return false;
  if (typeof obj.id !== "string" || !obj.id) return false;
  if (typeof obj.chatId !== "string") return false;
  if (typeof obj.kind !== "string") return false;
  if (typeof obj.mark !== "number") return false;
  if (!obj.asset || typeof obj.asset !== "object") return false;
  const asset = obj.asset as Record<string, unknown>;
  if (typeof asset.uri !== "string" || typeof asset.format !== "string") return false;
  return true;
}
