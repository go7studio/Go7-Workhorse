function stripWrappingQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "").trim();
}

export function workhorseUserDataOverride(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.WORKHORSE_USER_DATA_PATH?.trim();
  if (fromEnv) return fromEnv;
  const idx = argv.findIndex((arg) => arg.startsWith("--workhorse-user-data="));
  if (idx < 0) return undefined;
  let fromFlag = stripWrappingQuotes(argv[idx].slice("--workhorse-user-data=".length));
  // Start-Process on Windows drops quotes, so "Go7 Workhorse Dev" arrives as extra tokens.
  for (let i = idx + 1; i < argv.length; i++) {
    const next = argv[i];
    if (!next || next.startsWith("-")) break;
    fromFlag = stripWrappingQuotes(`${fromFlag} ${next}`);
  }
  return fromFlag || undefined;
}

export function workhorseVolatileCredentials(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const fromEnv = env.WORKHORSE_VOLATILE_CREDENTIALS?.trim().toLowerCase();
  if (fromEnv === "1" || fromEnv === "true") return true;
  return argv.includes("--workhorse-volatile-credentials");
}
