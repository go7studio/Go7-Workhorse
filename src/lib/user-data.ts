function unwrapPath(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function workhorseUserDataOverride(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.WORKHORSE_USER_DATA_PATH?.trim();
  if (fromEnv) return unwrapPath(fromEnv);
  const flag = argv.find((arg) => arg.startsWith("--workhorse-user-data="));
  const fromFlag = flag?.slice("--workhorse-user-data=".length);
  return fromFlag ? unwrapPath(fromFlag) || undefined : undefined;
}

export function workhorseVolatileCredentials(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const fromEnv = env.WORKHORSE_VOLATILE_CREDENTIALS?.trim().toLowerCase();
  if (fromEnv === "1" || fromEnv === "true") return true;
  return argv.includes("--workhorse-volatile-credentials");
}
