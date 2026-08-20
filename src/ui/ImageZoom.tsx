import { useEffect, useState, type MouseEvent } from "react";

function originFromClick(event: MouseEvent<HTMLImageElement>): { x: number; y: number } {
  const box = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(100, Math.max(0, ((event.clientX - box.left) / Math.max(1, box.width)) * 100)),
    y: Math.min(100, Math.max(0, ((event.clientY - box.top) / Math.max(1, box.height)) * 100)),
  };
}

export function ImageZoom({
  src,
  alt,
  className,
  decoding = "async",
  loading = "lazy",
}: {
  src: string;
  alt: string;
  className?: string;
  decoding?: "async" | "auto" | "sync";
  loading?: "eager" | "lazy";
}) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        setScale(1);
        setOrigin({ x: 50, y: 50 });
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setScale((value) => Math.min(4, value + 0.5));
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setScale((value) => Math.max(1, value - 0.5));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => {
    setOpen(false);
    setScale(1);
    setOrigin({ x: 50, y: 50 });
  };

  const openAt = (event: MouseEvent<HTMLImageElement>) => {
    setOrigin(originFromClick(event));
    setScale(1);
    setOpen(true);
  };

  const toggleZoom = (event: MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (scale > 1) {
      setScale(1);
      return;
    }
    setOrigin(originFromClick(event));
    setScale(2);
  };

  return (
    <>
      <button className="image-zoom-open" type="button" aria-label={alt ? `Open ${alt}` : "Open image"}>
        <img className={className} src={src} alt={alt} decoding={decoding} loading={loading} onClick={openAt} />
      </button>
      {open ? (
        <div className="image-zoom" role="dialog" aria-modal="true" aria-label={alt || "Image"} onClick={close}>
          <button className="image-zoom-close" type="button" onClick={close} aria-label="Close image">
            Close
          </button>
          <img
            className={scale > 1 ? "zoomed" : ""}
            src={src}
            alt={alt}
            decoding={decoding}
            style={{ transform: `scale(${scale})`, transformOrigin: `${origin.x}% ${origin.y}%` }}
            onClick={toggleZoom}
          />
        </div>
      ) : null}
    </>
  );
}
