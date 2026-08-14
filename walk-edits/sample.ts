export function greet(name: string): string {
  const trimmed = name.trim() || "there";
  return `hello ${trimmed}`;
}

export const STEPS = ["list", "setup", "select", "review"];

export function labelFor(step: string): string {
  return step.toUpperCase();
}
