import type { ChatImage, TaskDomain } from "./types";

/**
 * Does this prompt look like it is about code? One definition serves two
 * rules: the quick tier must not swallow a short-but-codey ask, and the
 * domain tie-break should send code work to models strong at it.
 */
export function looksCodey(text: string): boolean {
  return (
    /```/.test(text) ||
    /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|py|go|rs|rb|java|cs|cpp|cc|h|swift|kt|gd|sql|sh|bash|yml|yaml|toml|json)\b/i.test(text) ||
    /\b(function|class|import|const|async|await|struct|enum|interface|typedef|regex|compile|typecheck|stack trace|traceback|segfault|null pointer|exception|unit test|test suite|lint|refactor|implement|component|api|endpoint|mutex|thread|queue|algorithm)\b/i.test(text) ||
    // A language, framework or engine named in the ask is code work even when no code word is.
    /\b(typescript|javascript|python|rust|golang|kotlin|react|vue|svelte|node\.?js|electron|gdscript|godot|css|html|frontend|backend|codebase|repo|repository)\b/i.test(text) ||
    /=>|::|\(\)|\{\}|\[\]/.test(text)
  );
}

/** Ask to *produce* an image from text. Conservative: generation verb + image noun. */
export function detectsImageGenerationIntent(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (!text) return false;
  if (
    /\b(analy[sz]e|describe|explain|inspect|review|ocr|transcribe|caption|what(?:'s| is)|tell me about)\b/.test(text) &&
    /\b(image|picture|photo|screenshot|illustration|drawing)\b/.test(text)
  ) {
    return false;
  }
  const imageNoun = /\b(image|picture|illustration|photo|drawing|artwork)\b/.test(text);
  if (!imageNoun) return false;
  return (
    /\b(generate|create|draw|imagine|paint|render|sketch)\b/.test(text) ||
    /\bmake\b[\s\S]{0,40}\b(image|picture|illustration|photo|drawing|artwork)\b/.test(text)
  );
}

/** What the prompt is mostly about. Explicit request fields win over inference. */
export function inferTaskDomain(prompt: string, attachments: ChatImage[] = []): TaskDomain {
  const text = prompt.trim();
  if (!text && attachments.length === 0) return "general";
  if (looksCodey(text)) return "coding";
  const lower = text.toLowerCase();
  if (detectsImageGenerationIntent(text)) return "image-generation";
  if (/\b(csv|sql|spreadsheet|dataset|dashboard|pivot|rows|columns|chart|plot|histogram|median|regression|analy[sz]e the (data|numbers))\b/.test(lower)) {
    return "data";
  }
  if (
    attachments.some((item) => item.kind === "image") ||
    /\b(screenshots?|mockups?|illustration|figma|visual|pixel|artwork|storyboard)\b/.test(lower)
  ) {
    return "visual";
  }
  if (/\b(write|draft|rewrite|blog|article|essay|email|newsletter|copy|caption|tagline|announcement|readme|docs?|documentation|prose|tone|headline|post)\b/.test(lower)) {
    return "writing";
  }
  return "general";
}
