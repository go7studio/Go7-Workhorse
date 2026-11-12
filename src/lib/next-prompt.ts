/**
 * One short prompt to put in the composer when a reply reports a failure.
 * A passing count such as "0 failed" is not a failure.
 */
export function nextPromptForReply(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  if (/sealed resource|codesign --verify failed|release was refused|did not publish/i.test(flat)) {
    return "Fix the release";
  }
  if (/\b(?:check jobs|checks|ci) (?:are |is )?(?:still )?fail|\bpull request is red\b/i.test(flat)) {
    return "Fix the checks";
  }
  return undefined;
}
