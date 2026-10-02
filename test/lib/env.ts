// Environment variables set for the length of one call, for a test that sets a
// limit the service reads from the environment.
//
//   await withEnv({ REGISTRATION_BURST: "3", REGISTRATION_PER_HOUR: undefined }, async () => { ... });

/**
 * Run `fn` with each variable set, or unset where the value is undefined, then put
 * every one back as it was, unset included, however `fn` ends.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}
