export function workhorseUserDataOverride(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.WORKHORSE_USER_DATA_PATH?.trim();
  if (fromEnv) return fromEnv;
  const flag = argv.find((arg) => arg.startsWith("--workhorse-user-data="));
  const fromFlag = flag?.slice("--workhorse-user-data=".length).trim();
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
