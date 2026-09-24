/**
 * Leading blank lines and trailing whitespace go; the first line's indent
 * stays. A full trim cut the indent off the first line of a code block, so an
 * indented Python or YAML snippet pasted back broken.
 */
export function copyText(text: string): Promise<boolean> {
  const value = text.replace(/^\s*\n/, "").trimEnd();
  if (!value.trim() || !navigator.clipboard?.writeText) return Promise.resolve(false);
  return navigator.clipboard.writeText(value).then(
    () => true,
    () => false,
  );
}
