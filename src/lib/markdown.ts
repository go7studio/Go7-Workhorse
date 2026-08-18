export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "image"; text: string; href: string };

export type MdAlign = "left" | "right" | "center";

export type MdBlock =
  | { type: "p"; children: Inline[] }
  | { type: "ul"; items: Inline[][] }
  | { type: "ol"; items: Inline[][] }
  | { type: "h"; level: number; children: Inline[] }
  | { type: "table"; headers: Inline[][]; rows: Inline[][][]; aligns: MdAlign[] }
  | { type: "pre"; text: string }
  | { type: "facts"; rows: { label: string; value: string }[] }
  | { type: "image"; alt: string; href: string };

const FACT =
  /^\s*[-*]\s+\*\*([^*]+?):\*\*\s*(.+?)\s*$|^\s*[-*]\s+\*\*([^*]+?)\*\*:\s*(.+?)\s*$/;

export function wrapMarkdown(
  source: string,
  start: number,
  end: number,
  mark: string,
): { text: string; start: number; end: number } {
  const from = Math.max(0, Math.min(start, end, source.length));
  const to = Math.max(0, Math.min(Math.max(start, end), source.length));
  const selected = source.slice(from, to) || "text";
  const open = mark;
  const close = mark;
  const wrapped = selected.startsWith(open) && selected.endsWith(close) && selected.length > open.length + close.length;
  const inner = wrapped ? selected.slice(open.length, selected.length - close.length) : selected;
  const next = wrapped ? inner : `${open}${inner}${close}`;
  return {
    text: `${source.slice(0, from)}${next}${source.slice(to)}`,
    start: from,
    end: from + next.length,
  };
}

export function looksLikeImageHref(href: string): boolean {
  const value = href.trim();
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(value)) return true;
  if (/^https?:\/\//i.test(value) && /(imagine|imagedelivery|twimg|grok\.com|x\.ai|cdn\.|generated)/i.test(value)) {
    return true;
  }
  if (/^(file:|[a-zA-Z]:[\\/]|\\\\|\/)/.test(value) && /\.(png|jpe?g|gif|webp|bmp)$/i.test(value)) return true;
  return false;
}

export function isHollowHref(href: string): boolean {
  const value = href.trim();
  return !value || value === "#" || value === "about:blank" || value === "javascript:void(0)";
}

function asLinkedMedia(label: string, href: string, forcedImage: boolean): Inline {
  if (forcedImage || looksLikeImageHref(href) || isHollowHref(href)) {
    return { type: "image", text: label, href };
  }
  return { type: "link", text: label, href };
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*[^*]+?\*\*|`[^`]+`|!?\[[^\]]*\]\([^)]*\)|\*[^*\n]+?\*)/g;
  let last = 0;
  for (const match of source.matchAll(re)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ type: "text", text: source.slice(last, at) });
    const token = match[0];
    if (token.startsWith("**")) out.push({ type: "strong", text: token.slice(2, -2) });
    else if (token.startsWith("`")) out.push({ type: "code", text: token.slice(1, -1) });
    else if (token.startsWith("![")) {
      const image = token.match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
      if (image) out.push(asLinkedMedia(image[1], image[2], true));
      else out.push({ type: "text", text: token });
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]*)\)$/);
      if (link) out.push(asLinkedMedia(link[1], link[2], false));
      else out.push({ type: "text", text: token });
    } else if (token.startsWith("*")) {
      out.push({ type: "em", text: token.slice(1, -1) });
    } else out.push({ type: "text", text: token });
    last = at + token.length;
  }
  if (last < source.length) out.push({ type: "text", text: source.slice(last) });
  return out.length > 0 ? out : [{ type: "text", text: source }];
}

function unwrapTicks(value: string): string {
  return value.replace(/^`([\s\S]*)`$/, "$1");
}

export function parseFactLine(line: string): { label: string; value: string } | null {
  const match = line.match(FACT);
  if (!match) return null;
  const label = (match[1] ?? match[3] ?? "").trim();
  const value = unwrapTicks((match[2] ?? match[4] ?? "").trim());
  return label ? { label, value } : null;
}

export function joinChatText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
  if (/[.!?:]$/.test(left) && /^[A-Z([{]/.test(right)) return `${left} ${right}`;
  if (/[a-z0-9)]$/.test(left) && /^[A-Z]/.test(right)) return `${left} ${right}`;
  return left + right;
}

/** Merge a streamed fragment while tolerating providers that replay cumulative or overlapping text. */
export function mergeStreamedText(left: string, right: string): string {
  if (!left) return right;
  if (!right || left.endsWith(right)) return left;
  if (right.startsWith(left)) return right;
  const limit = Math.min(left.length, right.length);
  for (let overlap = limit; overlap > 0; overlap -= 1) {
    if (left.slice(-overlap) === right.slice(0, overlap)) return left + right.slice(overlap);
  }
  return joinChatText(left, right);
}

export function unsquashSentences(text: string): string {
  return String(text ?? "").replace(/([.!?])([A-Z][a-z])/g, "$1 $2");
}

const PLANNING_LEAD =
  /^(I'|I'll|I[’']ll|I will|I am|I'm|I[’']m|Let me|Looking|Checking|Listing|Joining|Sending|Confirming|Binding|First[, ]|The (user|sidebar|connected|shell|file|write_file|tool|Set-Content|append|current file|previous)|Here are the ones|No "|OK[,—]|Okay[,—]|Excellent|Then (I |let |determine)|But —|Wait[, ]|Actually[, ]|Hmm|I (should|notice|noticed|can't|can[’']t|cannot|need to)|Now (I |I'll |I[’']ll |let |write )|Confirmed:|Good[ —–,.]|Plan:|Better plan|Approach:|File got|OK that|Quick sanity|Final verification|Project should |Project is already |Project is bound )/i;

const PROCESS_NARRATION =
  /\b(write_file|read_file|run_command|findstr|Set-Content|Get-Content|Add-Content|AppendAllText|Out-File|PLACEHOLDER_TAIL|truncated mid-sentence|char limit|em-dashes?)\b/i;

const PROCESS_SENTENCE =
  /^(I['’]ll |I will |I am going to |I['’]m going to |Let me |Looking |Checking |Listing |Joining |Sending |Confirming |Binding |Project should |Project is already |Project is bound )/i;

const USER_LEAD =
  /^(I want to|What I can do|The honest answer|If you|There are more|This chat|Here(?:'s| is)|Done\b|Sure[—,]|Sorry[, ]|No files were|Yes\s*[—–-])/i;

const OUTPUT_LINE =
  /^(?:#{1,6}\s+|[-*•●]\s+\S|\d+\.\s+\S|(?:By vendor|By project|Provider breakdown|A few standouts|Status:)\b|Yes\s*[—–-]\s)/i;

function firstLine(text: string): string {
  return text.trim().split(/\n/)[0] ?? "";
}

function isPlanningParagraph(text: string): boolean {
  const first = firstLine(text);
  if (USER_LEAD.test(first)) return false;
  if (/^#{1,6}\s/.test(first) || isTableLine(first)) return false;
  if (OUTPUT_LINE.test(first) && !PROCESS_NARRATION.test(text)) return false;
  return (
    PLANNING_LEAD.test(first) ||
    PROCESS_SENTENCE.test(first) ||
    PROCESS_NARRATION.test(text) ||
    /\s{2,}>\s/.test(text)
  );
}

function containsMarkdownTable(text: string): boolean {
  return text.split("\n").some((line) => isTableLine(line));
}

function isLockedAnswerParagraph(text: string): boolean {
  const first = firstLine(text);
  if (!first) return false;
  if (/^#{1,6}\s/.test(first) || isTableLine(first) || containsMarkdownTable(text) || /^>\s+\S/.test(first) || /^Preview:/i.test(first)) {
    return true;
  }
  if (OUTPUT_LINE.test(first) && !PROCESS_NARRATION.test(text)) return true;
  return USER_LEAD.test(first);
}

/** True when a cut lead is only mid-turn process — never a report that happens to contain an I'll. */
function leadIsOnlyProcess(lead: string): boolean {
  const trimmed = lead.trim();
  if (!trimmed) return false;
  if (containsMarkdownTable(trimmed) || /^#{1,6}\s/m.test(trimmed)) return false;
  const sentences = splitReplySentences(trimmed);
  if (sentences.length === 0) return false;
  return sentences.every((sentence) => isProcessSentence(sentence) || Boolean(polarityKey(sentence)));
}

/** Short reasoning that starts like a hidden draft, not a user-facing report. */
function shouldCutLead(lead: string): boolean {
  if (leadIsOnlyProcess(lead)) return true;
  const trimmed = lead.trim();
  if (!trimmed || containsMarkdownTable(trimmed) || /^#{1,6}\s/m.test(trimmed)) return false;
  if (trimmed.length > 500) return false;
  return /^(The user|I should |Let me |I'll |I['’]ll )/i.test(firstLine(trimmed));
}

function isProcessSentence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (isLockedAnswerParagraph(trimmed) && !PROCESS_NARRATION.test(trimmed)) return false;
  return isPlanningParagraph(trimmed) || PROCESS_SENTENCE.test(trimmed);
}

function splitReplySentences(text: string): string[] {
  const parts = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split(
      /(?<=[.!?:])\s+(?=(?:[A-Z*>]|I['’]ll |I will |Let me |Looking |Checking |Listing |Sending |Joining |Not |No\.|Yes\.))/,
    )
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : text.trim() ? [text.trim()] : [];
}

function polarityKey(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^(yes|no)\.?$/i.test(trimmed)) return "polarity";
  if (/^(not intentional|that wasn['’]?t intentional)\.?$/i.test(trimmed)) return "polarity";
  return undefined;
}

function sentenceWords(text: string): string[] {
  return normalizeOverlap(text)
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function isRestatementOf(earlier: string, later: string): boolean {
  if (polarityKey(earlier) && polarityKey(later)) return true;
  const words = sentenceWords(earlier);
  if (words.length < 3) return false;
  const laterWords = new Set(sentenceWords(later));
  const overlap = words.filter((word) => laterWords.has(word)).length;
  return overlap / words.length >= 0.72;
}

function isConclusionParagraph(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /\s{2,}>\s/.test(trimmed)) return false;
  if (isPlanningParagraph(trimmed)) return false;
  return USER_LEAD.test(firstLine(trimmed));
}

const ASK_NAMES = "ask|question|options|option|item|label|description";

function tidyAskText(value: string): string {
  return value
    .replace(new RegExp(`</?(?:${ASK_NAMES})\\b[^>]*>`, "gi"), " ")
    .replace(new RegExp(`(?:^|[\\s*])(?:${ASK_NAMES})>`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagInner(block: string, name: string): string {
  const match = block.match(new RegExp(`<?${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return tidyAskText(match?.[1] ?? "");
}

function formatAskItem(index: number, label: string, description: string): string {
  const title = tidyAskText(label);
  let detail = tidyAskText(description);
  if (!title) return "";
  if (detail && title.includes(detail)) detail = "";
  if (detail && detail.includes(title)) detail = detail.replace(title, "").replace(/^[\s—–-]+/, "").trim();
  return `${index}. **${title}**${detail ? ` — ${detail}` : ""}`;
}

/** Turn MiniMax <Ask>/<options> dumps into a readable list. Never leave the tags on the page. */
export function peelAskMarkup(text: string): string {
  let next = String(text ?? "");
  next = next.replace(/<?ask\b[^>]*>[\s\S]*?<\/ask>/gi, (block) => {
    const question = tagInner(block, "question");
    const chunks = [...block.matchAll(/<?item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((item) => item[1] ?? "");
    const items = chunks.flatMap((chunk, index) => {
      const label = tagInner(chunk, "label") || tidyAskText(chunk);
      const description = tagInner(chunk, "description");
      const line = formatAskItem(index + 1, label, description);
      return line ? [line] : [];
    });
    return [question, ...items].filter(Boolean).join("\n\n");
  });
  next = next.replace(new RegExp(`</?(?:${ASK_NAMES})\\b[^>]*>`, "gi"), "");
  next = next.replace(new RegExp(`(?:^|\\n)\\s*(\\d+\\.\\s*)?(?:\\*\\*)?(?:${ASK_NAMES})>\\s*`, "gi"), (_all, num: string) =>
    num ? `\n${num}` : "\n",
  );
  next = next.replace(new RegExp(`(?:^|[\\s*])(?:${ASK_NAMES})>`, "gi"), " ");
  return next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const THINK_TAG = /<\/?(?:[a-z][\w-]*:)?think(?:ing)?\b[^>]*>/gi;

function isCloseThinkTag(tag: string): boolean {
  return /^<\//.test(tag);
}

/** Pull MiniMax/Grok think markup (`<think>`, `<mm:think>`, orphan closes) out of the visible reply. */
export function peelThinkTags(text: string): { thought: string; body: string } {
  const source = String(text ?? "");
  if (!source) return { thought: "", body: "" };
  const thoughts: string[] = [];
  let body = "";
  let last = 0;
  let inThink = false;
  const tag = new RegExp(THINK_TAG.source, THINK_TAG.flags);
  let match = tag.exec(source);
  if (!match) return { thought: "", body: source };
  while (match) {
    const chunk = source.slice(last, match.index);
    const close = isCloseThinkTag(match[0]);
    if (inThink) {
      if (chunk.trim()) thoughts.push(chunk.trim());
      inThink = !close;
    } else if (close) {
      if (chunk.trim()) thoughts.push(chunk.trim());
    } else {
      body += chunk;
      inThink = true;
    }
    last = match.index + match[0].length;
    match = tag.exec(source);
  }
  const tail = source.slice(last);
  if (inThink) {
    if (tail.trim()) thoughts.push(tail.trim());
  } else {
    body += tail;
  }
  body = body.replace(THINK_TAG, "").replace(/\n{3,}/g, "\n\n").trim();
  return { thought: thoughts.join("\n\n"), body };
}

type ReplyUnit = { text: string; para: number; kind: "thought" | "answer" };

function splitPlanningSentences(para: string): { thought: string; body: string } {
  const parts = splitReplySentences(para);
  if (parts.length < 2) {
    return isProcessSentence(para) && !isConclusionParagraph(para)
      ? { thought: para, body: "" }
      : { thought: "", body: para };
  }
  const thought = parts.filter((item) => isProcessSentence(item) && !isConclusionParagraph(item));
  const body = parts.filter((item) => !isProcessSentence(item) || isConclusionParagraph(item));
  return { thought: thought.join(" "), body: body.join(" ") };
}

function unitsFromParagraph(para: string, paraIndex: number): ReplyUnit[] {
  if (isLockedAnswerParagraph(para) && !PROCESS_NARRATION.test(para)) {
    return [{ text: para, para: paraIndex, kind: "answer" }];
  }
  const parts = splitReplySentences(para);
  if (parts.length <= 1) {
    const process = isProcessSentence(para) && !isConclusionParagraph(para);
    return [{ text: para, para: paraIndex, kind: process ? "thought" : "answer" }];
  }
  return parts.map((text) => ({
    text,
    para: paraIndex,
    kind: isProcessSentence(text) && !isConclusionParagraph(text) ? "thought" : "answer",
  }));
}

function dropRestatedAnswers(units: ReplyUnit[]): ReplyUnit[] {
  const answers = units.filter((unit) => unit.kind === "answer");
  const drop = new Set<number>();
  for (let i = 0; i < answers.length; i += 1) {
    const earlier = answers[i];
    if (!earlier) continue;
    for (let j = i + 1; j < answers.length; j += 1) {
      const later = answers[j];
      if (later && isRestatementOf(earlier.text, later.text)) {
        drop.add(i);
        break;
      }
    }
  }
  let seen = 0;
  return units.map((unit) => {
    if (unit.kind !== "answer") return unit;
    const index = seen;
    seen += 1;
    return drop.has(index) ? { ...unit, kind: "thought" } : unit;
  });
}

function joinUnits(units: ReplyUnit[], kind: ReplyUnit["kind"]): string {
  const wanted = units.filter((unit) => unit.kind === kind);
  if (wanted.length === 0) return "";
  const paras: string[] = [];
  let currentPara = wanted[0]?.para;
  let bucket: string[] = [];
  const flush = () => {
    if (bucket.length) paras.push(bucket.join(" "));
    bucket = [];
  };
  for (const unit of wanted) {
    if (unit.para !== currentPara) {
      flush();
      currentPara = unit.para;
    }
    bucket.push(unit.text);
  }
  flush();
  return paras.join("\n\n");
}

function peelPlanningUnits(
  source: string,
  extraThought = "",
  live = false,
): { thought: string; body: string } {
  const paras = source.split(/\n\n+/).map((item) => item.trim()).filter(Boolean);
  const units = dropRestatedAnswers(paras.flatMap((para, index) => unitsFromParagraph(para, index)));
  const thoughtParas = [extraThought, joinUnits(units, "thought")].filter((item) => item.trim());
  const bodyParas = joinUnits(units, "answer");
  if (live && !bodyParas) {
    return { thought: thoughtParas.join("\n\n") || source.trim(), body: "" };
  }
  if (!bodyParas) {
    const sentences = splitReplySentences(source);
    if (!live && sentences.length <= 1 && source.trim().length < 420) {
      return { thought: extraThought, body: source };
    }
    return { thought: thoughtParas.join("\n\n"), body: "" };
  }
  return { thought: thoughtParas.join("\n\n"), body: bodyParas };
}

const LOCKED_TAIL =
  /(?<=[.!?])\s+(?=(?:This chat|Here(?:'s| is)|I want to|What I can do|The honest answer|There are more|Done\b|Sure[—,]|Sorry[, ]|No files were|Yes\s*[—–-]))/i;

export function peelPlanningPreamble(text: string, live = false): { thought: string; body: string } {
  if (!text) return { thought: "", body: text ?? "" };
  const tagged = peelThinkTags(text);
  const source = tagged.body || text;
  const locked = source.match(LOCKED_TAIL);
  if (locked && locked.index !== undefined && locked.index >= 20) {
    const lead = source.slice(0, locked.index).trim();
    const rest = source.slice(locked.index + locked[0].length).trim();
    if (lead && shouldCutLead(lead)) {
      return peelPlanningUnits(rest, [tagged.thought, lead].filter(Boolean).join("\n\n"), live);
    }
  }
  const heading = source.match(/\n(?=#{1,6}\s+|[-*•●]\s+\S|\s*\|.+\|)/);
  if (heading && heading.index !== undefined && heading.index >= 40) {
    const lead = source.slice(0, heading.index).trim();
    const rest = source.slice(heading.index).trim();
    if (shouldCutLead(lead)) {
      return peelPlanningUnits(rest, [tagged.thought, lead].filter(Boolean).join("\n\n"), live);
    }
  }
  return peelPlanningUnits(source, tagged.thought, live);
}

function normalizeOverlap(text: string): string {
  return text.toLowerCase().replace(/[*_`>#]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Cut a drafted user-facing answer off the end of a thinking block. */
const INLINE_OUTPUT =
  /(?<=[.!?:])\s+(?=(?:Yes\s*[—–-]|By vendor|By project|Provider breakdown|Here(?:'s| is)\b|A few standouts|Status:))/i;

function splitInlineOutput(text: string): { thought: string; leaked: string } {
  const inline = text.search(INLINE_OUTPUT);
  if (inline >= 40) {
    return { thought: text.slice(0, inline).trim(), leaked: text.slice(inline).trim() };
  }
  return { thought: text, leaked: "" };
}

export function splitThoughtFromOutput(text: string): { thought: string; leaked: string } {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return { thought: "", leaked: "" };
  const lines = raw.split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    if (OUTPUT_LINE.test(line) && (i > 0 || !isPlanningParagraph(line))) {
      cut = i;
      break;
    }
  }
  if (cut === 0) return { thought: "", leaked: raw };
  const head = cut > 0 ? lines.slice(0, cut).join("\n").trim() : raw;
  const tail = cut > 0 ? lines.slice(cut).join("\n").trim() : "";
  const inline = splitInlineOutput(head);
  return { thought: inline.thought, leaked: [inline.leaked, tail].filter(Boolean).join("\n") };
}

/** Drop thought lines that are the same as the visible reply. */
export function dropOverlappingReply(thought: string, body: string): string {
  const bodyNorm = normalizeOverlap(body);
  if (!thought.trim() || bodyNorm.length < 24) return thought;
  if (normalizeOverlap(thought) === bodyNorm) return "";
  const bodyLines = body
    .split(/\n+/)
    .map((line) => normalizeOverlap(line))
    .filter((line) => line.length >= 20);
  const kept: string[] = [];
  for (const line of thought.split("\n")) {
    const n = normalizeOverlap(line);
    if (!n) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (n.length >= 20 && bodyLines.some((item) => item.includes(n) || n.includes(item))) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Thought accordion should keep reasoning, never the user-facing output. */
export function stripOutputFromThought(thought: string, visibleBody = ""): string {
  const split = splitThoughtFromOutput(thought);
  let kept = split.thought;
  if (visibleBody.trim()) kept = dropOverlappingReply(kept, visibleBody);
  return kept.trim();
}

export function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && /^\|?.+\|.+$/.test(trimmed) && trimmed.split("|").length >= 3;
}

export function isTableRule(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function isEmptyOrRuleCell(cell: string): boolean {
  const trimmed = cell.trim();
  return !trimmed || isTableRule(trimmed);
}

/** Empty pipe rows and orphan `|---` that Grok's terminal dumps around a real table. */
export function isTableChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitTableCells(trimmed);
  return cells.length > 0 && cells.every(isEmptyOrRuleCell);
}

function isHollowTableLine(line: string): boolean {
  if (!isTableChromeLine(line)) return false;
  return splitTableCells(line).every((cell) => !cell.trim());
}

function isTableRelatedLine(line: string): boolean {
  return isTableLine(line) || isTableChromeLine(line);
}

export function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

export function expandMashedRows(line: string): string[] {
  return line
    .replace(/\|\s*(\|?\s*:?-{3,}:?\s*)+\|/g, "|\n$&\n|")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAlign(cell: string): MdAlign {
  const trimmed = cell.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
  if (trimmed.endsWith(":")) return "right";
  return "left";
}

export function parseMarkdownTable(rawLines: string[]): Extract<MdBlock, { type: "table" }> | null {
  const lines = rawLines
    .flatMap(expandMashedRows)
    .filter((line) => isTableRelatedLine(line) && !isHollowTableLine(line));
  while (lines.length > 0 && isTableChromeLine(lines[0] ?? "")) lines.shift();
  if (lines.length < 2) return null;
  const grid = lines.map(splitTableCells);
  let aligns: MdAlign[] = grid[0].map(() => "left");
  let data = grid;
  if (grid[1] && grid[1].every(isTableRule)) {
    aligns = grid[1].map(parseAlign);
    data = [grid[0], ...grid.slice(2)];
  }
  if (data.length === 0) return null;
  const width = Math.max(...data.map((row) => row.length));
  const padded = data.map((row) => {
    const next = row.slice();
    while (next.length < width) next.push("");
    return next;
  });
  const body = padded.slice(1).filter((row) => !row.every(isEmptyOrRuleCell));
  return {
    type: "table",
    headers: padded[0].map((cell) => parseInline(cell)),
    rows: body.map((row) => row.map((cell) => parseInline(cell))),
    aligns,
  };
}

export function parseChatMarkdown(source: string): MdBlock[] {
  const lines = peelAskMarkup(String(source ?? "")).replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i += 1;
      continue;
    }
    if (lines[i].startsWith("```")) {
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "pre", text: body.join("\n") });
      continue;
    }
    const picture = lines[i].trim().match(/^!?\[([^\]]*)\]\(([^)]*)\)\.?$/);
    if (picture) {
      blocks.push({ type: "image", alt: picture[1], href: picture[2] });
      i += 1;
      continue;
    }
    const heading = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      blocks.push({ type: "h", level, children: parseInline(heading[2]) });
      i += 1;
      continue;
    }
    if (isTableRelatedLine(lines[i])) {
      const chunk: string[] = [];
      while (i < lines.length && (isTableRelatedLine(lines[i]) || !lines[i].trim())) {
        if (lines[i].trim()) chunk.push(lines[i]);
        i += 1;
      }
      const table = parseMarkdownTable(chunk);
      if (table) {
        blocks.push(table);
        continue;
      }
      if (chunk.every((line) => isTableChromeLine(line))) continue;
      blocks.push({ type: "p", children: parseInline(chunk.join(" ")) });
      continue;
    }
    const facts: { label: string; value: string }[] = [];
    let j = i;
    while (j < lines.length) {
      const fact = parseFactLine(lines[j]);
      if (!fact) break;
      facts.push(fact);
      j += 1;
    }
    if (facts.length >= 2) {
      blocks.push({ type: "facts", rows: facts });
      i = j;
      continue;
    }
    if (/^\s*[-*]\s+/.test(lines[i])) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*[-*]\s+/, "")));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(lines[i])) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*\d+\.\s+/, "")));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith("```") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !isTableRelatedLine(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length === 0) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ type: "p", children: parseInline(para.join(" ")) });
  }
  return blocks;
}
