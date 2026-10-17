import { useCallback, useEffect, useRef, useState, useMemo, useLayoutEffect, memo } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Annotation, AnnotationCamera, ViewerAsset } from "../lib/viewer";
import { buildAnnotation, formatMarksForChat, nextAnnotationMark, viewerRenderUrl, viewerResourceUrl } from "../lib/viewer";
import { uid } from "../lib/id";

type ViewerMode = "3d" | "2d";

type ViewerPanelProps = {
  sessionId: string;
  asset: ViewerAsset | null;
  annotations: Annotation[];
  onAnnotation: (annotation: Annotation) => void;
  onSendMarks: (text: string) => void;
  onClearMarks: () => void;
  onOpenFile: () => void;
  onClose: () => void;
  onStatus?: (status: "loaded" | "error", detail?: string) => void;
  canMark?: boolean;
};

const PIN_COLORS = [
  0xff2255, 0x22ff55, 0x2255ff, 0xffaa22, 0xaa22ff,
  0x22ffaa, 0xff22aa, 0xaaff22, 0x22aaff, 0xff5522,
];

function pinColor(mark: number): number {
  return PIN_COLORS[(mark - 1) % PIN_COLORS.length];
}

function PinLabel({ mark, x, y, note }: { mark: number; x: number; y: number; note: string }) {
  return (
    <div
      className="viewer-pin-label"
      style={{
        left: x,
        top: y,
        transform: "translate(-50%, -100%)",
        background: `#${pinColor(mark).toString(16).padStart(6, "0")}`,
      }}
      title={note || `Pin ${mark}`}
    >
      {mark}
    </div>
  );
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}

const ThreeViewer = memo(function ThreeViewer({
  asset,
  annotations,
  onRaycast,
  onStatus,
}: {
  asset: ViewerAsset;
  annotations: Annotation[];
  onStatus?: (status: "loaded" | "error", detail?: string) => void;
  onRaycast: (hit: {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    object: THREE.Object3D;
    faceIndex: number;
    uv?: THREE.Vector2;
    distance: number;
    screenX: number;
    screenY: number;
    camera: AnnotationCamera;
  }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pinsRef = useRef<THREE.Mesh[]>([]);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  const pointerStart = useRef<[number, number] | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202530);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(2.2, 1.6, 3.2);
    camera.lookAt(0, 0.6, 0);
    cameraRef.current = camera;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "3D rendering is unavailable.";
      container.dataset.model = "error";
      container.dataset.modelError = detail;
      onStatusRef.current?.("error", detail);
      return;
    }
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resize = new ResizeObserver(handleResize);
    resize.observe(container);
    window.addEventListener("resize", handleResize);

    return () => {
      resize.disconnect();
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationId);
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      sceneRef.current = null;
      cameraRef.current = null;
      modelRef.current = null;
      pinsRef.current = [];
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls || !asset) return;

    if (modelRef.current) {
      scene.remove(modelRef.current);
      disposeObject(modelRef.current);
      modelRef.current = null;
    }

    let cancelled = false;
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => viewerResourceUrl(asset, url));
    const loader = new GLTFLoader(manager);
    loader.setResourcePath("workhorse-preview-resource://local/");
    if (containerRef.current) {
      containerRef.current.dataset.model = "loading";
      delete containerRef.current.dataset.modelError;
    }
    loader.load(
      viewerRenderUrl(asset),
      (gltf) => {
        const model = gltf.scene;
        if (cancelled) { disposeObject(model); return; }
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.001);
        scene.add(model);
        modelRef.current = model;

        const dist = maxDim * 1.8 / Math.min(1, camera.aspect);
        camera.position.set(center.x + dist, center.y + dist * 0.7, center.z + dist);
        camera.lookAt(center);
        controls.target.copy(center);
        controls.update();
        if (containerRef.current) containerRef.current.dataset.model = "loaded";
        onStatusRef.current?.("loaded");
      },
      undefined,
      (error) => {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : "Could not load this file.";
        if (containerRef.current) {
          containerRef.current.dataset.model = "error";
          containerRef.current.dataset.modelError = detail;
        }
        onStatusRef.current?.("error", detail);
      }
    );
    return () => { cancelled = true; };
  }, [asset.uri, asset.loadedAt]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    for (const pin of pinsRef.current) {
      scene.remove(pin);
      pin.geometry.dispose();
      (pin.material as THREE.Material).dispose();
    }
    pinsRef.current = [];

    for (const ann of annotations) {
      if (ann.target?.worldPoint) {
        const [x, y, z] = ann.target.worldPoint;
        const geometry = new THREE.SphereGeometry(0.035);
        const material = new THREE.MeshBasicMaterial({
          color: pinColor(ann.mark),
          depthTest: false,
        });
        const pin = new THREE.Mesh(geometry, material);
        pin.position.set(x, y, z);
        pin.renderOrder = 999;
        scene.add(pin);
        pinsRef.current.push(pin);
      }
    }
  }, [annotations]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const down = pointerStart.current;
      pointerStart.current = null;
      if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
      const container = containerRef.current;
      const camera = cameraRef.current;
      const scene = sceneRef.current;
      if (!container || !camera || !scene || !modelRef.current) return;

      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      mouseRef.current.x = (x / rect.width) * 2 - 1;
      mouseRef.current.y = -(y / rect.height) * 2 + 1;

      raycasterRef.current.setFromCamera(mouseRef.current, camera);
      const intersects = raycasterRef.current.intersectObject(modelRef.current, true);

      if (intersects.length > 0) {
        const hit = intersects[0];
        if (hit.face) {
          const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
          onRaycast({
            point: hit.point.clone(),
            normal,
            object: hit.object,
            faceIndex: hit.faceIndex ?? 0,
            uv: hit.uv?.clone(),
            distance: hit.distance,
            screenX: Math.round(x),
            screenY: Math.round(y),
            camera: {
              position: camera.position.toArray() as [number, number, number],
              quaternion: camera.quaternion.toArray() as [number, number, number, number],
              fovDeg: camera.fov,
              viewport: [Math.round(rect.width), Math.round(rect.height)],
              upAxis: "Y",
            },
          });
        }
      }
    },
    [onRaycast]
  );

  return (
    <div
      ref={containerRef}
      className="viewer-canvas"
      onPointerDown={(event) => { pointerStart.current = [event.clientX, event.clientY]; }}
      onClick={handleClick}
      style={{ width: "100%", height: "100%", minHeight: 180 }}
    />
  );
});

const ImageViewer = memo(function ImageViewer({ asset, annotations, onRaycast, onStatus }: {
  asset: ViewerAsset;
  annotations: Annotation[];
  onRaycast: (hit: { x: number; y: number; imageWidth: number; imageHeight: number }) => void;
  onStatus?: (status: "loaded" | "error", detail?: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [bounds, setBounds] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const measure = useCallback(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return;
    const rect = img.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    setBounds({ x: rect.left - parent.left, y: rect.top - parent.top, width: rect.width, height: rect.height });
  }, []);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, [measure, asset.uri, asset.loadedAt]);
  return (
    <div className="viewer-image-container" ref={containerRef}>
      <img ref={imgRef} src={viewerRenderUrl(asset)} alt="Viewer asset"
        onLoad={() => { measure(); onStatus?.("loaded"); }}
        onError={() => onStatus?.("error", "Could not load this image.")}
        onClick={(event) => {
          const img = imgRef.current;
          if (!img?.naturalWidth || !img.naturalHeight) return;
          const rect = img.getBoundingClientRect();
          onRaycast({
            x: Math.round(((event.clientX - rect.left) / rect.width) * img.naturalWidth),
            y: Math.round(((event.clientY - rect.top) / rect.height) * img.naturalHeight),
            imageWidth: img.naturalWidth, imageHeight: img.naturalHeight,
          });
        }}
      />
      {annotations.filter((annotation) => annotation.region2d?.px).map((annotation) => {
        const [x, y] = annotation.region2d!.px!;
        const [width, height] = annotation.region2d!.imageSize;
        return <PinLabel key={annotation.id} mark={annotation.mark}
          x={bounds.x + x / width * bounds.width} y={bounds.y + y / height * bounds.height} note={annotation.note} />;
      })}
    </div>
  );
});

export function ViewerPanel({
  sessionId,
  asset,
  annotations,
  onAnnotation,
  onSendMarks,
  onClearMarks,
  onOpenFile,
  onClose,
  onStatus,
  canMark = true,
}: ViewerPanelProps) {
  const [note, setNote] = useState("");
  const [modelError, setModelError] = useState("");
  const annotationsForViewer = useMemo(
    () => annotations.filter((annotation) => annotation.asset.uri === asset?.uri),
    [annotations, asset?.uri],
  );

  const mode: ViewerMode | "file" = useMemo(() => {
    if (!asset || asset.format === "file") return "file";
    return asset.format === "png" || asset.format === "jpg" ? "2d" : "3d";
  }, [asset]);

  useEffect(() => {
    setNote("");
    setModelError("");
  }, [asset?.uri]);

  const nextMark = asset ? nextAnnotationMark(annotations, asset.uri) : 1;
  useEffect(() => {
    if (asset?.format === "file") onStatus?.("loaded");
  }, [asset?.path, asset?.loadedAt, onStatus]);

  const handle3dRaycast = useCallback(
    (hit: {
      point: THREE.Vector3;
      normal: THREE.Vector3;
      object: THREE.Object3D;
      faceIndex: number;
      uv?: THREE.Vector2;
      distance: number;
      screenX: number;
      screenY: number;
      camera: AnnotationCamera;
    }) => {
      if (!canMark) return;
      const mark = nextMark;
      const id = uid();
      const objectPath: string[] = [];
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.type !== "Scene") {
        objectPath.unshift(obj.name || obj.type);
        obj = obj.parent;
      }


      if (asset) {
        const annotation = buildAnnotation({
          id,
          chatId: sessionId,
          kind: "3d-point",
          note,
          mark,
          asset: {
            uri: asset.uri,
            format: asset.format as "glb" | "gltf" | "png" | "jpg",
          },
          target: {
            objectName: hit.object.name || hit.object.type,
            objectPath: objectPath.join("/"),
            uuid: hit.object.uuid,
            faceIndex: hit.faceIndex,
            faceIndexSpace: "glTF triangle",
            worldPoint: [
              parseFloat(hit.point.x.toFixed(4)),
              parseFloat(hit.point.y.toFixed(4)),
              parseFloat(hit.point.z.toFixed(4)),
            ],
            localPoint: (() => {
              const local = hit.object.worldToLocal(hit.point.clone());
              return [
                parseFloat(local.x.toFixed(4)),
                parseFloat(local.y.toFixed(4)),
                parseFloat(local.z.toFixed(4)),
              ];
            })(),
            worldNormal: [
              parseFloat(hit.normal.x.toFixed(4)),
              parseFloat(hit.normal.y.toFixed(4)),
              parseFloat(hit.normal.z.toFixed(4)),
            ],
            uv: hit.uv ? [parseFloat(hit.uv.x.toFixed(4)), parseFloat(hit.uv.y.toFixed(4))] : null,
            distance: parseFloat(hit.distance.toFixed(4)),
          },
          camera: hit.camera,
          screenPx: [hit.screenX, hit.screenY],
        });
        onAnnotation(annotation);
      }
      setNote("");
    },
    [asset, note, nextMark, canMark, sessionId, onAnnotation]
  );

  const handle2dRaycast = useCallback(
    (hit: { x: number; y: number; imageWidth: number; imageHeight: number }) => {
      if (!canMark) return;
      const mark = nextMark;
      const id = uid();


      if (asset) {
        const annotation = buildAnnotation({
          id,
          chatId: sessionId,
          kind: "2d-point",
          note,
          mark,
          asset: {
            uri: asset.uri,
            format: asset.format as "glb" | "gltf" | "png" | "jpg",
          },
          region2d: {
            imageSize: [hit.imageWidth, hit.imageHeight],
            px: [hit.x, hit.y],
          },
          camera: {
            position: [0, 0, 1],
            quaternion: [0, 0, 0, 1],
            fovDeg: 0,
            viewport: [hit.imageWidth, hit.imageHeight],
          },
          screenPx: [hit.x, hit.y],
        });
        onAnnotation(annotation);
      }
      setNote("");
    },
    [asset, note, nextMark, canMark, sessionId, onAnnotation]
  );

  const sendMarks = () => {
    if (!asset) return;
    onSendMarks(formatMarksForChat({
      filePath: asset.path,
      format: asset.format,
      annotations: annotationsForViewer,
      note,
    }));
  };

  return (
    <section className="viewer-panel" aria-label="3D preview">
      <div className="viewer-panel-head">
        <strong>Preview</strong>
        <span className="row-meta">
          {asset ? asset.path.split("/").pop() : "No file"}
        </span>
        <div className="viewer-panel-actions">
          <button className="tiny" type="button" onClick={onOpenFile}>
            Open
          </button>
          <button className="tiny" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="viewer-panel-body">
        {asset && mode === "3d" ? (
          <ThreeViewer
            asset={asset}
            annotations={annotationsForViewer}
            onRaycast={handle3dRaycast}
            onStatus={(status, detail) => { setModelError(detail ?? ""); onStatus?.(status, detail); }}
          />
        ) : asset && mode === "2d" ? (
          <ImageViewer
            asset={asset}
            annotations={annotationsForViewer}
            onRaycast={handle2dRaycast}
            onStatus={(status, detail) => { setModelError(detail ?? ""); onStatus?.(status, detail); }}
          />
        ) : (
          <div className="viewer-empty">
            <p>{asset ? asset.path.split("/").pop() : "No file open."}</p>
            <p className="row-meta">
              {asset
                ? "This preview draws GLB, glTF, PNG, and JPG. The path can still go to the chat, and the model picks the tool."
                : "Open a file, or put a GLB, glTF, PNG, or JPG in the project .workhorse/preview folder. Mark it, then add the marks to the chat."}
            </p>
          </div>
        )}
        {modelError ? <p className="viewer-error" role="alert">{modelError}</p> : null}
      </div>
      <div className="viewer-annotation-bar">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={mode === "file" || !asset ? "Note for the chat…" : `Note for pin ${nextMark}…`}
          aria-label="Note for preview marks"
          className="viewer-note-input"
        />
        <span className="row-meta">{!canMark ? "Loading marks…" : mode === "3d" || mode === "2d" ? `Click to place pin ${nextMark}` : "Path and note"}</span>
        <button className="tiny" type="button" disabled={!asset || !canMark} onClick={sendMarks}>
          To chat
        </button>
      </div>
      {annotationsForViewer.length > 0 && (
        <div className="viewer-pins-list">
          <span className="row-meta">{annotationsForViewer.length} pin{annotationsForViewer.length !== 1 ? "s" : ""}</span>
          <button
            className="tiny"
            type="button"
            onClick={() => {
              onClearMarks();
            }}
          >
            Clear pins
          </button>
        </div>
      )}
    </section>
  );
}
