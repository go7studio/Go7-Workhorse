import { useCallback, useEffect, useRef, useState, useMemo, memo } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Annotation, ViewerAsset } from "../lib/viewer";
import { buildAnnotation } from "../lib/viewer";
import { uid } from "../lib/id";

type ViewerMode = "3d" | "2d";

type PinData = {
  id: string;
  mark: number;
  position: THREE.Vector3;
  note: string;
  screenX?: number;
  screenY?: number;
};

type ViewerPanelProps = {
  sessionId: string;
  asset: ViewerAsset | null;
  annotations: Annotation[];
  onAnnotation: (annotation: Annotation) => void;
  onClose: () => void;
  onSnapshot?: () => Promise<string | null>;
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

const ThreeViewer = memo(function ThreeViewer({
  asset,
  annotations,
  onRaycast,
}: {
  asset: ViewerAsset;
  annotations: Annotation[];
  onRaycast: (hit: {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    object: THREE.Object3D;
    faceIndex: number;
    uv?: THREE.Vector2;
    distance: number;
    screenX: number;
    screenY: number;
  }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const pinsRef = useRef<THREE.Mesh[]>([]);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());

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

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
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
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationId);
      controls.dispose();
      renderer.dispose();
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
      modelRef.current = null;
    }

    const loader = new GLTFLoader();
    loader.load(
      asset.uri,
      (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 2 / maxDim;
        model.scale.multiplyScalar(scale);
        model.position.sub(center.multiplyScalar(scale));
        scene.add(model);
        modelRef.current = model;

        const dist = 2.5;
        camera.position.set(dist, dist * 0.7, dist);
        camera.lookAt(0, 0, 0);
        controls.target.set(0, 0, 0);
        controls.update();
      },
      undefined,
      (error) => {
        console.error("GLTFLoader error:", error);
      }
    );
  }, [asset?.uri]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    for (const pin of pinsRef.current) {
      scene.remove(pin);
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
      onClick={handleClick}
      style={{ width: "100%", height: "100%", minHeight: 300 }}
    />
  );
});

const ImageViewer = memo(function ImageViewer({
  asset,
  annotations,
  onRaycast,
}: {
  asset: ViewerAsset;
  annotations: Annotation[];
  onRaycast: (hit: { x: number; y: number; imageWidth: number; imageHeight: number }) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      if (!img) return;
      const rect = img.getBoundingClientRect();
      const x = Math.round(((event.clientX - rect.left) / rect.width) * img.naturalWidth);
      const y = Math.round(((event.clientY - rect.top) / rect.height) * img.naturalHeight);
      onRaycast({ x, y, imageWidth: img.naturalWidth, imageHeight: img.naturalHeight });
    },
    [onRaycast]
  );

  return (
    <div className="viewer-image-container">
      <img
        ref={imgRef}
        src={asset.uri}
        alt="Viewer asset"
        onClick={handleClick}
        style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", cursor: "crosshair" }}
      />
      {annotations
        .filter((ann) => ann.region2d?.px)
        .map((ann) => {
          const [px, py] = ann.region2d!.px!;
          const [iw, ih] = ann.region2d!.imageSize;
          const img = imgRef.current;
          if (!img) return null;
          const rect = img.getBoundingClientRect();
          const x = (px / iw) * rect.width;
          const y = (py / ih) * rect.height;
          return <PinLabel key={ann.id} mark={ann.mark} x={x} y={y} note={ann.note} />;
        })}
    </div>
  );
});

export function ViewerPanel({
  sessionId,
  asset,
  annotations,
  onAnnotation,
  onClose,
}: ViewerPanelProps) {
  const [note, setNote] = useState("");
  const [pins, setPins] = useState<PinData[]>([]);
  const cameraRef = useRef<{ position: THREE.Vector3; quaternion: THREE.Quaternion } | null>(null);
  const viewportRef = useRef<[number, number]>([800, 600]);

  const mode: ViewerMode = useMemo(() => {
    if (!asset) return "3d";
    return asset.format === "png" || asset.format === "jpg" ? "2d" : "3d";
  }, [asset?.format]);

  useEffect(() => {
    setPins([]);
    setNote("");
  }, [asset?.uri]);

  const nextMark = pins.length + 1;

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
    }) => {
      const mark = pins.length + 1;
      const id = uid();
      const objectPath: string[] = [];
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.type !== "Scene") {
        objectPath.unshift(obj.name || obj.type);
        obj = obj.parent;
      }

      setPins((prev) => [
        ...prev,
        {
          id,
          mark,
          position: hit.point,
          note: note,
          screenX: hit.screenX,
          screenY: hit.screenY,
        },
      ]);

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
          camera: {
            position: cameraRef.current
              ? [cameraRef.current.position.x, cameraRef.current.position.y, cameraRef.current.position.z]
              : [2.2, 1.6, 3.2],
            quaternion: cameraRef.current
              ? [
                  cameraRef.current.quaternion.x,
                  cameraRef.current.quaternion.y,
                  cameraRef.current.quaternion.z,
                  cameraRef.current.quaternion.w,
                ]
              : [0, 0, 0, 1],
            fovDeg: 45,
            viewport: viewportRef.current,
          },
          screenPx: [hit.screenX, hit.screenY],
        });
        onAnnotation(annotation);
      }
      setNote("");
    },
    [asset, note, pins.length, sessionId, onAnnotation]
  );

  const handle2dRaycast = useCallback(
    (hit: { x: number; y: number; imageWidth: number; imageHeight: number }) => {
      const mark = pins.length + 1;
      const id = uid();

      setPins((prev) => [
        ...prev,
        {
          id,
          mark,
          position: new THREE.Vector3(hit.x, hit.y, 0),
          note,
          screenX: hit.x,
          screenY: hit.y,
        },
      ]);

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
    [asset, note, pins.length, sessionId, onAnnotation]
  );

  const annotationsForViewer = useMemo(
    () => annotations.filter((a) => a.asset.uri === asset?.uri),
    [annotations, asset?.uri]
  );

  return (
    <section className="viewer-panel" aria-label="3D Viewer">
      <div className="viewer-panel-head">
        <strong>Viewer</strong>
        <span className="row-meta">
          {asset ? asset.uri.split("/").pop() : "No asset loaded"}
        </span>
        <div className="viewer-panel-actions">
          <button className="tiny" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="viewer-panel-body">
        {asset ? (
          mode === "3d" ? (
            <ThreeViewer
              asset={asset}
              annotations={annotationsForViewer}
              onRaycast={handle3dRaycast}
            />
          ) : (
            <ImageViewer
              asset={asset}
              annotations={annotationsForViewer}
              onRaycast={handle2dRaycast}
            />
          )
        ) : (
          <div className="viewer-empty">
            <p>No asset loaded.</p>
            <p className="row-meta">
              Export a GLB or render a PNG from Blender to see it here.
            </p>
          </div>
        )}
      </div>
      <div className="viewer-annotation-bar">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={`Note for pin ${nextMark}…`}
          className="viewer-note-input"
        />
        <span className="row-meta">Click to place pin {nextMark}</span>
      </div>
      {pins.length > 0 && (
        <div className="viewer-pins-list">
          <span className="row-meta">{pins.length} pin{pins.length !== 1 ? "s" : ""}</span>
          <button
            className="tiny"
            type="button"
            onClick={() => setPins([])}
          >
            Clear pins
          </button>
        </div>
      )}
    </section>
  );
}
