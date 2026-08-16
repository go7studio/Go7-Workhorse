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
