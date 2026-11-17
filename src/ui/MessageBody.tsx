import { memo, useEffect, useRef, useState, type MouseEvent } from "react";
import { isLocalHtmlHref, parseChatMarkdown, parseInline, type Inline } from "../lib/markdown";
import { isPassThroughImageHref, mdImageInitialSrc } from "../lib/media-display";
import { safeExternalUrl } from "../lib/open-external";
import { copyText } from "../lib/copy-text";
import { harvestFilePath } from "../lib/project-edits";
import { editFromMention, isOpenableSource, useFileOpen } from "./FileOpen";
import { ImageZoom } from "./ImageZoom";

function openWebUrl(url: string) {
  if (window.workhorse?.openExternal) {
    void window.workhorse.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** The main process remembers a miss for 10 seconds. One retry after that, then stop. */
export const MEDIA_LOAD_RETRY_MS = 10_000;

export function mediaRetrySrc(src: string): string {
  if (!src) return src;
  const join = src.includes("?") ? "&" : "?";
  return `${src}${join}retry=1`;
}

function MediaFallback({ label, path }: { label: string; path: string }) {
  const name = label.trim();
  const file = path.trim();
  const text = name && file && name !== file ? `${name} ${file}` : file || name;
  if (!text) return null;
  return <p className="md-image-fallback">{text}</p>;
}

function useMediaLoad(src: string) {
  const [retrySrc, setRetrySrc] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const tries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    tries.current = 0;
    setRetrySrc(null);
    setWaiting(false);
    setFailed(false);
    return () => clearTimeout(timer.current);
  }, [src]);

  const onError = () => {
    if (tries.current >= 1) {
      setFailed(true);
      setWaiting(false);
      return;
    }
    tries.current = 1;
    setWaiting(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setRetrySrc(mediaRetrySrc(src));
      setWaiting(false);
    }, MEDIA_LOAD_RETRY_MS);
  };

  return { src: retrySrc ?? src, waiting, failed, onError };
}

function MdImage({
  href,
  alt,
  cwd,
  vendorSessionId,
}: {
  href: string;
  alt: string;
  cwd?: string;
  vendorSessionId?: string;
}) {
  const [src, setSrc] = useState(() => mdImageInitialSrc(href, { cwd, vendorSessionId }));
  const load = useMediaLoad(src);
  useEffect(() => {
    const next = mdImageInitialSrc(href, { cwd, vendorSessionId });
    setSrc(next);
    if (!next || isPassThroughImageHref(href) || /^(blob:|workhorse-media:)/i.test(next)) return;
    let gone = false;
    void window.workhorse?.mediaSrc?.(href, cwd, vendorSessionId).then((resolved) => {
      if (!gone && resolved) setSrc(resolved);
    });
    return () => {
      gone = true;
    };
  }, [href, cwd, vendorSessionId]);
  if (!src || load.waiting) {
    return <span className="md-image-pending" aria-hidden="true" />;
  }
  if (load.failed) return <MediaFallback label={alt} path={href} />;
  return (
    <figure className="md-figure">
      <ImageZoom className="md-image" src={load.src} alt={alt} decoding="async" loading="lazy" onError={load.onError} />
      {alt ? <figcaption>{alt}</figcaption> : null}
    </figure>
  );
}

export function MdPlayable({
  href,
  alt,
  kind,
  cwd,
  vendorSessionId,
  caption,
}: {
  href: string;
  alt: string;
  kind: "video" | "audio";
  cwd?: string;
  vendorSessionId?: string;
  caption: boolean;
}) {
  const src = mdImageInitialSrc(href, { cwd, vendorSessionId });
  const load = useMediaLoad(src);
  if (!src || load.waiting) return <span className="md-image-pending" aria-hidden="true" />;
  if (load.failed) return <MediaFallback label={alt} path={href} />;
  const media =
    kind === "audio" ? (
      <audio className="md-audio" src={load.src} controls preload="metadata" aria-label={alt || undefined} onError={load.onError} />
    ) : (
      <video className="md-video" src={load.src} controls preload="metadata" playsInline aria-label={alt || undefined} onError={load.onError} />
    );
  if (!caption) return media;
  return (
    <figure className="md-figure">
      {media}
      {alt ? <figcaption>{alt}</figcaption> : null}
    </figure>
  );
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-pre">
      <button
        className="md-pre-copy"
        type="button"
        onClick={() => {
          void copyText(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{text}</pre>
    </div>
  );
}

function Inlines({
  parts,
  nearby = "",
  cwd,
  vendorSessionId,
}: {
  parts: Inline[];
  nearby?: string;
  cwd?: string;
  vendorSessionId?: string;
}) {
  const fileOpen = useFileOpen();
  const openSource = (value: string) => {
    if (!fileOpen || !isOpenableSource(value)) return false;
    const path = harvestFilePath(value, nearby);
    fileOpen.open(editFromMention(path, fileOpen.provider, fileOpen.roots));
    return true;
  };
  const onLink = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    event.preventDefault();
    event.stopPropagation();
    const url = safeExternalUrl(href);
    if (url) {
      openWebUrl(url);
      return;
    }
    const openPage = window.workhorse?.openLocalHtml;
    if (openPage && isLocalHtmlHref(href)) {
      void openPage(href).then((opened) => {
        if (!opened) openSource(href);
      });
      return;
    }
    openSource(href);
  };
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "strong") return <strong key={index}>{part.text}</strong>;
        if (part.type === "em") return <em key={index}>{part.text}</em>;
        if (part.type === "code") {
          if (fileOpen && isOpenableSource(part.text)) {
            return (
              <button
                key={index}
                className="md-file"
                type="button"
                title={`Open ${part.text}`}
                onClick={() => openSource(part.text)}
              >
                {part.text}
              </button>
            );
          }
          return <code key={index}>{part.text}</code>;
        }
        if (part.type === "image") {
          return <MdImage key={index} href={part.href} alt={part.text} cwd={cwd} vendorSessionId={vendorSessionId} />;
        }
        if (part.type === "video" || part.type === "audio") {
          return (
            <MdPlayable
              key={index}
              href={part.href}
              alt={part.text}
              kind={part.type}
              cwd={cwd}
              vendorSessionId={vendorSessionId}
              caption={false}
            />
          );
        }
        if (part.type === "link") {
          return (
            <a
              key={index}
              href={part.href}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => onLink(event, part.href)}
            >
              {part.children && part.children.length > 0 ? (
                part.children.map((label, at) => {
                  if (label.type === "strong") return <strong key={at}>{label.text}</strong>;
                  if (label.type === "em") return <em key={at}>{label.text}</em>;
                  if (label.type === "code") return <code key={at}>{label.text}</code>;
                  return <span key={at}>{label.text}</span>;
                })
              ) : (
                part.text
              )}
            </a>
          );
        }
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

export const MessageBody = memo(function MessageBody({
  text,
  cwd,
  vendorSessionId,
}: {
  text: string;
  cwd?: string;
  vendorSessionId?: string;
}) {
  const blocks = parseChatMarkdown(text ?? "");
  return (
    <div className="md">
      {blocks.map((block, index) => {
        if (block.type === "pre") {
          return <CodeBlock key={index} text={block.text} />;
        }
        if (block.type === "ul") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inlines parts={item} nearby={text} cwd={cwd} vendorSessionId={vendorSessionId} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inlines parts={item} nearby={text} cwd={cwd} vendorSessionId={vendorSessionId} />
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === "h") {
          const Tag = (block.level <= 2 ? "h3" : "h4") as "h3" | "h4";
          return (
            <Tag key={index} className={`md-h md-h${block.level}`}>
              <Inlines parts={block.children} nearby={text} cwd={cwd} vendorSessionId={vendorSessionId} />
            </Tag>
          );
        }
        if (block.type === "table") {
          return (
            <div key={index} className="md-table-wrap">
              <table className="md-table">
                <thead>
                  <tr>
                    {block.headers.map((cell, cellIndex) => (
                      <th key={cellIndex} style={{ textAlign: block.aligns[cellIndex] ?? "left" }}>
                        <Inlines parts={cell} nearby={text} cwd={cwd} vendorSessionId={vendorSessionId} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} style={{ textAlign: block.aligns[cellIndex] ?? "left" }}>
                          <Inlines parts={cell} nearby={text} cwd={cwd} vendorSessionId={vendorSessionId} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === "image") {
          return <MdImage key={index} href={block.href} alt={block.alt} cwd={cwd} vendorSessionId={vendorSessionId} />;
        }
        if (block.type === "video" || block.type === "audio") {
          return (
            <MdPlayable
              key={index}
              href={block.href}
              alt={block.alt}
              kind={block.type}
              cwd={cwd}
              vendorSessionId={vendorSessionId}
              caption
            />
          );
        }
        if (block.type === "facts") {
          return (
            <dl key={index} className="facts">
              {/* By position: a reply can repeat a label ("Status" twice), and a
                  repeated key made React drop or duplicate rows as it streamed. */}
              {block.rows.map((row, rowIndex) => (
                <div key={rowIndex} className="fact">
                  <dt>{row.label}</dt>
                  <dd>
                    <Inlines parts={parseInline(row.value)} nearby={text} cwd={cwd} vendorSessionId={vendorSessionId} />
                  </dd>
                </div>
              ))}
            </dl>
          );
        }
        return (
          <p key={index}>
            <Inlines parts={block.children} nearby={text} cwd={cwd} vendorSessionId={vendorSessionId} />
          </p>
        );
      })}
    </div>
  );
});
