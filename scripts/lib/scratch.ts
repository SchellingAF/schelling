// What the local measurement scripts share: their flags, and a scratch database
// cloned from the test template. Local only: the superuser here is the test
// stack's, whose password is public on purpose.

import postgres from "postgres";

/** The value after `--name` on the command line, or undefined. */
export const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

/** The test stack's superuser, on `port`. */
export const superuser = (port: number) => ({
  host: "127.0.0.1",
  port,
  username: "postgres",
  password: "test_superuser_password_not_a_secret",
  database: "postgres",
  max: 1,
  onnotice: () => {},
});

/** `database`, dropped if it exists and made again from the test template. */
export async function cloneTemplate(port: number, database: string): Promise<void> {
  const admin = postgres(superuser(port));
  try {
    await admin.unsafe(`drop database if exists ${database} with (force)`);
    await admin.unsafe(`create database ${database} template schellingaf_tmpl owner schellingaf_owner`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
