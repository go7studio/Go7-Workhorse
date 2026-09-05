import { useEffect, useRef, type ReactNode } from "react";
import {
  WORKSHOP_UNKNOWN,
  galleryItems,
  gaugePercent,
  paintValue,
  pickCase,
  ratioPercent,
  resolveBinding,
  type Card as PackCard,
  type GalleryItem,
  type PackDocuments,
  type PackView,
  type Tone,
  type Value,
  type Widget,
} from "../lib/workshop-pack";
import { copyText } from "../lib/copy-text";
import { clipLog, flagWords, joinParts, probeRows } from "./workshop-live";

// ---------------------------------------------------------------------------------------------
// Paint primitives. Each draws one value from the current snapshot; nothing is stored between polls.

/** One dominant gauge per card: a hairline ring with an accent arc, painted from the current snapshot. */
function Ring({ value, size }: { value: unknown; size: number }) {
  const pct = gaugePercent(value);
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arc = pct == null ? 0 : (c * pct) / 100;
  return (
    <div
      className={`workshop-ring${pct == null ? " is-unknown" : ""}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={pct == null ? "unknown" : `${Math.round(pct)}%`}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="workshop-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        {pct == null ? null : (
          <circle
            className="workshop-ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={`${arc} ${c - arc}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="workshop-ring-value">
        <strong>{pct == null ? WORKSHOP_UNKNOWN : Math.round(pct)}</strong>
        {pct == null ? null : <small>%</small>}
      </span>
    </div>
  );
}

/** A snapshot bar: a ratio the pack names, drawn from the current documents only. */
function Bar({ pct, label, showPct = true }: { pct: number | null; label: string; showPct?: boolean }) {
  return (
    <div className={`workshop-bar${pct == null ? " is-unknown" : ""}`} role="img" aria-label={label}>
      <div className="workshop-bar-track">
        {pct == null ? null : <div className="workshop-bar-fill" style={{ width: `${pct}%` }} />}
      </div>
      {showPct ? <span>{pct == null ? WORKSHOP_UNKNOWN : `${pct.toFixed(1)}%`}</span> : null}
    </div>
  );
}

function Dot({ tone }: { tone: Tone }) {
  return <i className={`workshop-dot workshop-dot-${tone}`} aria-hidden="true" />;
}

/** The `writer` format with its dot: ok for one, warn for no, a bare dash when unknown. */
function Writer({ value }: { value: unknown }) {
  if (value === true) return <><Dot tone="ok" /> one</>;
  if (value === false) return <><Dot tone="warn" /> no</>;
  return <>{WORKSHOP_UNKNOWN}</>;
}

export function Chip({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`workshop-chip workshop-chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Label left, value right. The value wraps instead of clipping; there is no track between them. */
function Kv({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="workshop-kv">
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

function Card({ heading, aside, children }: { heading: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="workshop-card">
      <div className="workshop-card-head">
        <div className="section-label">{heading}</div>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function Module({
  pack,
  folded,
  onFold,
  children,
}: {
  pack: PackView;
  folded: boolean;
  onFold: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`workshop-module${folded ? " is-folded" : ""}`} aria-label={pack.name}>
      <div className="workshop-module-head">
        <strong>{pack.name}</strong>
        <span className="row-meta">On · rail</span>
        <button
          className="tiny workshop-fold"
          type="button"
          aria-expanded={!folded}
          title={folded ? `Unfold ${pack.name}` : `Fold ${pack.name}`}
          onClick={onFold}
        >
          {folded ? "›" : "⌄"}
        </button>
      </div>
      {folded ? null : children}
    </section>
  );
}

/** The tail follows the newest line unless the user has scrolled up to read. */
function LogTail({ tail }: { tail: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [tail]);
  return (
    <pre
      ref={ref}
      className="workshop-log"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
    >
      {tail}
    </pre>
  );
}

// ---------------------------------------------------------------------------------------------
// Generic renderer: the closed pack vocabulary painted with the primitives above.

export type PaintVariant = "strip" | "card";

type PaintProps = { widget: Widget; documents: PackDocuments; now: number; variant: PaintVariant };

/** Formats that paint a number or a clock word; in the strip they sit as tabular kv text, other text is a line. */
const NUMBER_FORMATS = new Set(["int", "fixed1", "fixed2", "tokens", "watts", "hours", "wall", "clock", "age", "writer"]);

function isLiteral(spec: Value): spec is { value: string } {
  return "value" in spec;
}

function hasBinding(spec: Partial<Value>): spec is Value {
  return "value" in spec || typeof (spec as { of?: unknown }).of === "string";
}

/** A Value as a node: the writer format keeps its dot; everything else is paintValue's text. */
function valueNode(spec: Value, documents: PackDocuments, now: number): ReactNode {
  if (!isLiteral(spec) && spec.fmt === "writer") return <Writer value={resolveBinding(spec.of, documents)} />;
  return paintValue(spec, documents, now);
}

function titleOf(spec: Value | undefined, documents: PackDocuments, now: number): string | undefined {
  if (!spec) return undefined;
  const text = paintValue(spec, documents, now);
  return text === WORKSHOP_UNKNOWN ? undefined : text;
}

function stripTextClass(spec: Value): string {
  if (!isLiteral(spec) && spec.fmt && NUMBER_FORMATS.has(spec.fmt)) return "workshop-rail-kv";
  return "workshop-rail-models";
}

/**
 * Paint one widget from the pack vocabulary. `strip` is the 76px collapsed column; `card` is a
 * row inside a card. Every value is a format of a document field; the only ratio drawn is a bar's.
 */

function GalleryGrid({ items }: { items: GalleryItem[] }) {
  if (items.length === 0) {
    return <p className="row-meta">No outputs yet.</p>;
  }
  const openPath = (path: string | undefined) => {
    if (!path) return;
    void window.workhorse?.deskOpenLocalPath?.(path);
  };
  const revealPath = (path: string | undefined) => {
    if (!path) return;
    void window.workhorse?.deskRevealLocalPath?.(path);
  };
  const copyPath = (path: string | undefined) => {
    if (!path) return;
    void copyText(path);
  };
  return (
    <ul className="workshop-gallery" aria-label="Outputs">
      {items.map((item, i) => (
        <li key={`${item.label}-${i}`} className="workshop-gallery-item">
          <div className="workshop-gallery-meta">
            <Chip tone="mute">{item.kind}</Chip>
            <strong title={item.path ?? item.label}>{item.label}</strong>
          </div>
          {item.path ? (
            <div className="workshop-gallery-actions">
              <button className="tiny" type="button" onClick={() => openPath(item.path)}>Open</button>
              <button className="tiny" type="button" onClick={() => revealPath(item.path)}>Reveal</button>
              <button className="tiny" type="button" onClick={() => copyPath(item.path)}>Copy</button>
            </div>
          ) : (
            <span className="row-meta">No local path</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PaintWidget({ widget, documents, now, variant }: PaintProps): ReactNode {
  switch (widget.w) {
    case "ring":
      return <Ring value={resolveBinding(widget.of, documents)} size={widget.size ?? (variant === "strip" ? 44 : 56)} />;

    case "bar": {
      const pct = ratioPercent(resolveBinding(widget.num, documents), resolveBinding(widget.den, documents));
      return <Bar pct={pct} label={widget.label ?? "ratio"} showPct={widget.showPct !== false} />;
    }

    case "text": {
      const title = titleOf(widget.title, documents, now);
      const full = widget.parts
        ? joinParts(widget.parts, documents, now)
        : hasBinding(widget)
          ? paintValue(widget, documents, now)
          : WORKSHOP_UNKNOWN;
      if (widget.tone) {
        return (
          <Chip tone={widget.tone} title={title}>
            {full}
          </Chip>
        );
      }
      const text: ReactNode = !widget.parts && hasBinding(widget) ? valueNode(widget, documents, now) : full;
      if (variant === "strip") {
        return (
          <span className={widget.parts ? "workshop-rail-models" : stripTextClass(widget as Value)} title={title ?? full}>
            {text}
          </span>
        );
      }
      return (
        <p className="workshop-line" title={title}>
          {text}
        </p>
      );
    }

    case "kv": {
      const title = titleOf(widget.title, documents, now);
      const value: ReactNode = widget.parts
        ? joinParts(widget.parts, documents, now)
        : hasBinding(widget)
          ? valueNode(widget, documents, now)
          : WORKSHOP_UNKNOWN;
      return <Kv label={widget.label} value={value} title={title} />;
    }

    case "pair":
      return (
        <div className="workshop-progress">
          {([widget.a, widget.b] as Array<Value & { sub?: Value }>).map((side, i) => (
            <div key={i}>
              <strong>{paintValue(side, documents, now)}</strong>
              {side.sub ? <span className="row-meta">{paintValue(side.sub, documents, now)}</span> : null}
            </div>
          ))}
        </div>
      );

    case "meta": {
      const text = joinParts(widget.parts, documents, now);
      const title = titleOf(widget.title, documents, now);
      if (variant === "strip") {
        return (
          <span className="workshop-rail-models" title={title ?? text}>
            {text}
          </span>
        );
      }
      return (
        <p className="row-meta" title={title}>
          {text}
        </p>
      );
    }

    case "note":
      return <p className="row-meta workshop-law">{widget.value}</p>;

    case "chips": {
      const raw = resolveBinding(widget.of, documents);
      if (!Array.isArray(raw)) {
        return variant === "strip" ? <span className="workshop-rail-models">{WORKSHOP_UNKNOWN}</span> : <p className="workshop-line">{WORKSHOP_UNKNOWN}</p>;
      }
      const ids = raw.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
      return (
        <div className="workshop-chip-row">
          {ids.map((id) => (
            <Chip key={id} tone={widget.tone ?? "mute"} title={id}>
              {id}
            </Chip>
          ))}
        </div>
      );
    }

    case "probes": {
      const rows = probeRows((documents as Record<string, unknown>)[widget.of]);
      const detail = rows.find((row) => row.detail);
      return (
        <>
          <div className="workshop-chip-row">
            {rows.map((row) => (
              <Chip key={row.name} tone={row.tone} title={row.detail}>
                {row.label} · {row.status}
              </Chip>
            ))}
          </div>
          {detail ? (
            <p className="row-meta">
              {detail.label} · {detail.detail}
            </p>
          ) : null}
        </>
      );
    }

    case "flags": {
      const words = flagWords(resolveBinding(widget.of, documents), widget.words);
      if (words.length === 0) return null;
      if (variant === "strip") {
        return (
          <span className="workshop-rail-kv workshop-tone-warn" title={words.join(" · ")}>
            <Dot tone="warn" />
            {words.length === 1 ? words[0] : `${words.length} flags`}
          </span>
        );
      }
      return (
        <span className="workshop-chip-row workshop-flags">
          {words.map((word) => (
            <Chip key={word} tone="warn" title={word}>
              {word}
            </Chip>
          ))}
        </span>
      );
    }

    case "log":
      return <LogTail tail={clipLog(resolveBinding(widget.of, documents), widget.lines)} />;

    case "gallery": {
      const items = galleryItems(resolveBinding(widget.of, documents), widget.limit ?? 24);
      return <GalleryGrid items={items} />;
    }

    case "hbox": {
      const [first, ...rest] = widget.children;
      if (first?.w === "ring") {
        return (
          <div className="workshop-box">
            <PaintWidget widget={first} documents={documents} now={now} variant={variant} />
            <div className="workshop-box-kv">
              {rest.map((child, i) => (
                <PaintWidget key={i} widget={child} documents={documents} now={now} variant={variant} />
              ))}
            </div>
          </div>
        );
      }
      return (
        <div className="workshop-hbox">
          {widget.children.map((child, i) => (
            <PaintWidget key={i} widget={child} documents={documents} now={now} variant={variant} />
          ))}
        </div>
      );
    }

    case "switch": {
      const chosen = pickCase(widget, documents);
      return chosen ? <PaintWidget widget={chosen} documents={documents} now={now} variant={variant} /> : null;
    }

    default:
      return null;
  }
}

/** A card: `Title · name` when the name resolves, the aside right-aligned in the head, then its rows. */
export function PaintCard({ card, documents, now }: { card: PackCard; documents: PackDocuments; now: number }) {
  const name = card.name ? paintValue(card.name, documents, now) : WORKSHOP_UNKNOWN;
  return (
    <Card
      heading={
        name !== WORKSHOP_UNKNOWN ? (
          <>
            {card.title} · <span className="workshop-label-name">{name}</span>
          </>
        ) : (
          card.title
        )
      }
      aside={card.aside ? <PaintWidget widget={card.aside} documents={documents} now={now} variant="card" /> : null}
    >
      {card.rows.map((row, i) => (
        <PaintWidget key={i} widget={row} documents={documents} now={now} variant="card" />
      ))}
    </Card>
  );
}

/** One pack's cards, in pack order. */
export function PackCards({ pack, now }: { pack: PackView; now: number }) {
  return (
    <>
      {pack.cards.map((card, i) => (
        <PaintCard key={i} card={card} documents={pack.documents} now={now} />
      ))}
    </>
  );
}
