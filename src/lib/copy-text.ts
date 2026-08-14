export function copyText(text: string): Promise<boolean> {
  const value = text.trim();
  if (!value || !navigator.clipboard?.writeText) return Promise.resolve(false);
  return navigator.clipboard.writeText(value).then(
    () => true,
    () => false,
  );
}
