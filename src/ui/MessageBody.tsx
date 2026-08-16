import { useEffect, useState, type MouseEvent } from "react";
import { isHollowHref, looksLikeImageHref, parseChatMarkdown, parseInline, type Inline } from "../lib/markdown";
import { safeExternalUrl } from "../lib/open-external";
import { copyText } from "../lib/copy-text";
import { editFromMention, isOpenableSource, useFileOpen } from "./FileOpen";
import { ImageZoom } from "./ImageZoom";

function openWebUrl(url: string) {
  if (window.workhorse?.openExternal) {
    void window.workhorse.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
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
  const [src, setSrc] = useState(() => (looksLikeImageHref(href) && /^(data:|https?:)/i.test(href) ? href : ""));
  useEffect(() => {
    if (src && /^(data:|https?:)/i.test(src) && !isHollowHref(href)) return;
    let gone = false;
    void window.workhorse?.mediaSrc?.(href, cwd, vendorSessionId).then((next) => {
      if (!gone && next) setSrc(next);
    });
    return () => {
      gone = true;
    };
  }, [href, cwd, vendorSessionId, src]);
  if (!src) {
    return alt ? <span className="md-image-fallback">{alt}</span> : null;
  }
  return (
    <figure className="md-figure">
      <ImageZoom className="md-image" src={src} alt={alt} />
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
  cwd,
  vendorSessionId,
}: {
  parts: Inline[];
  cwd?: string;
  vendorSessionId?: string;
}) {
  const fileOpen = useFileOpen();
  const openSource = (value: string) => {
    if (!fileOpen || !isOpenableSource(value)) return false;
    fileOpen.open(editFromMention(value, fileOpen.provider, fileOpen.roots));
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
        if (part.type === "link") {
          return (
            <a
              key={index}
              href={part.href}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => onLink(event, part.href)}
            >
              {part.text}
            </a>
          );
        }
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

export function MessageBody({
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
                  <Inlines parts={item} cwd={cwd} vendorSessionId={vendorSessionId} />
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
                  <Inlines parts={item} cwd={cwd} vendorSessionId={vendorSessionId} />
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === "h") {
          const Tag = (block.level <= 2 ? "h3" : "h4") as "h3" | "h4";
          return (
            <Tag key={index} className={`md-h md-h${block.level}`}>
              <Inlines parts={block.children} cwd={cwd} vendorSessionId={vendorSessionId} />
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
                        <Inlines parts={cell} cwd={cwd} vendorSessionId={vendorSessionId} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} style={{ textAlign: block.aligns[cellIndex] ?? "left" }}>
                          <Inlines parts={cell} cwd={cwd} vendorSessionId={vendorSessionId} />
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
        if (block.type === "facts") {
          return (
            <dl key={index} className="facts">
              {block.rows.map((row) => (
                <div key={row.label} className="fact">
                  <dt>{row.label}</dt>
                  <dd>
                    <Inlines parts={parseInline(row.value)} cwd={cwd} vendorSessionId={vendorSessionId} />
                  </dd>
                </div>
              ))}
            </dl>
          );
        }
        return (
          <p key={index}>
            <Inlines parts={block.children} cwd={cwd} vendorSessionId={vendorSessionId} />
          </p>
        );
      })}
    </div>
  );
}
