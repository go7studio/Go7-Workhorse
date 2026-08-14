import type { Theme } from "./types";

export const THEME_ORDER: Theme[] = ["system", "light", "dark", "workhorse"];

export const THEME_CHOICES: { id: Theme; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "workhorse", label: "Workhorse" },
];

/** Settings appearance chips. Workhorse theme is the horse mark only. */
export const SETTINGS_THEME_CHOICES = THEME_CHOICES.filter((item) => item.id !== "workhorse");

export function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark" || value === "workhorse";
}

export function isConcreteTheme(value: unknown): value is Exclude<Theme, "workhorse"> {
  return value === "system" || value === "light" || value === "dark";
}

export function nextTheme(current: Theme): Theme {
  const index = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(index < 0 ? 0 : index + 1) % THEME_ORDER.length];
}

export function resolvedTheme(theme: Theme, prefersDark = false): Exclude<Theme, "system"> {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

export function applyWorkhorseToggle(
  current: Theme,
  previous?: Theme,
): { theme: Theme; themeReturn?: Exclude<Theme, "workhorse"> } {
  if (current === "workhorse") {
    return { theme: isConcreteTheme(previous) ? previous : "system" };
  }
  return { theme: "workhorse", themeReturn: isConcreteTheme(current) ? current : "system" };
}
