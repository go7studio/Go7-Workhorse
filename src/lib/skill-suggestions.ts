import type { DeskSkill } from "./types";

const COMMON_SKILL_WORDS = new Set([
  "a",
  "about",
  "agent",
  "all",
  "an",
  "and",
  "any",
  "app",
  "ask",
  "be",
  "build",
  "by",
  "can",
  "code",
  "create",
  "do",
  "edit",
  "file",
  "for",
  "from",
  "help",
  "in",
  "into",
  "is",
  "it",
  "make",
  "of",
  "on",
  "or",
  "read",
  "should",
  "skill",
  "that",
  "the",
  "their",
  "this",
  "to",
  "tool",
  "update",
  "use",
  "user",
  "want",
  "when",
  "with",
  "work",
]);

type RankedSkill = { skill: DeskSkill; score: number };

const ORIGIN_ORDER: Record<DeskSkill["origin"], number> = {
  workhorse: 0,
  grok: 1,
  cursor: 2,
  codex: 3,
  claude: 4,
};

function canonicalWord(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function words(text: string, keepCommon = false): string[] {
  const tokens = text
    .normalize("NFKD")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map(canonicalWord) ?? [];
  return [...new Set(tokens.filter((word) => word.length > 1 && (keepCommon || !COMMON_SKILL_WORDS.has(word))))];
}

function normalizedPhrase(text: string): string {
  return ` ${words(text, true).join(" ")} `;
}

function containsPhrase(haystack: string, needle: string): boolean {
  return needle.trim().length > 1 && haystack.includes(needle);
}

function relatedWord(promptWord: string, skillWord: string): boolean {
  if (promptWord === skillWord) return true;
  if (promptWord.length < 4 || skillWord.length < 4) return false;
  const difference = Math.abs(promptWord.length - skillWord.length);
  return difference <= 4 && (promptWord.startsWith(skillWord) || skillWord.startsWith(promptWord));
}

/**
 * Rank a few plausible installed workflows from natural task language.
 * This is intentionally conservative: one name hit or two descriptive hits
 * are required, so generic chat does not turn into a skill-loading ritual.
 */
export function suggestDeskSkills(skills: DeskSkill[], prompt: string, limit = 3): DeskSkill[] {
  if (limit <= 0 || !prompt.trim() || skills.length === 0) return [];
  const promptPhrase = normalizedPhrase(prompt);
  const promptWords = new Set(words(prompt));
  if (promptWords.size === 0) return [];

  const cards = skills.map((skill) => {
    const nameWords = words(skill.name);
    const descriptionWords = words(skill.description);
    return { skill, nameWords, descriptionWords };
  });
  const frequency = new Map<string, number>();
  for (const card of cards) {
    const terms = new Set([...card.nameWords, ...card.descriptionWords]);
    for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  const weight = (term: string) => 1 + Math.log2((skills.length + 1) / ((frequency.get(term) ?? 0) + 1));

  const ranked: RankedSkill[] = [];
  for (const card of cards) {
    const namePhrase = normalizedPhrase(card.skill.name);
    const qualifiedPhrase = normalizedPhrase(`${card.skill.origin} ${card.skill.name}`);
    const qualified = containsPhrase(promptPhrase, qualifiedPhrase);
    const named = containsPhrase(promptPhrase, namePhrase);
    const nameHits = card.nameWords.filter((term) => [...promptWords].some((promptWord) => relatedWord(promptWord, term)));
    const descriptionHits = card.descriptionWords.filter((term) => promptWords.has(term));
    if (!qualified && !named && nameHits.length === 0 && descriptionHits.length < 2) continue;

    const nameScore = nameHits.reduce((sum, term) => sum + 8 * weight(term), 0);
    const descriptionScore = descriptionHits.reduce((sum, term) => sum + weight(term), 0);
    ranked.push({
      skill: card.skill,
      score: (qualified ? 1_000 : 0) + (named ? 200 : 0) + nameScore + descriptionScore,
    });
  }

  const ordered = ranked
    .sort((left, right) =>
      right.score - left.score ||
      left.skill.name.localeCompare(right.skill.name) ||
      ORIGIN_ORDER[left.skill.origin] - ORIGIN_ORDER[right.skill.origin],
    );
  const selected: DeskSkill[] = [];
  const names = new Set<string>();
  for (const item of ordered) {
    const name = item.skill.name.toLowerCase();
    if (names.has(name)) continue;
    names.add(name);
    selected.push(item.skill);
    if (selected.length === limit) break;
  }
  return selected;
}

function shortDescription(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177).trimEnd()}…` : compact;
}

/** Add private, per-turn context without changing the user's visible message. */
export function withSkillDiscoveryHint(text: string, userPrompt: string, skills: DeskSkill[]): string {
  if (/^Use the installed skill\s+"/i.test(text.trimStart())) return text;
  const suggestions = suggestDeskSkills(skills, userPrompt);
  if (suggestions.length === 0) return text;
  const lines = [
    "Workhorse skill radar (private context; do not quote this block):",
    "The request resembles these installed skills:",
    ...suggestions.map((skill) => {
      const description = shortDescription(skill.description);
      return `- ${skill.origin}:${skill.name}${description ? ` — ${description}` : ""}`;
    }),
    "Before acting, call workhorse_list_skills and then workhorse_read_skill for each genuine match. Ignore false positives. Follow every matching SKILL.md fully.",
    "",
    text,
  ];
  return lines.join("\n");
}
