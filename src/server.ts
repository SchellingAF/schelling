// Process entry. Loads config (failing loudly on a placeholder), opens the
// database, serves the app, and shuts down without dropping a request.

import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { depositsOpen, fundingConfigLine } from "./funding/config.ts";
import { pubkeyCheckLine } from "./funding/cryptapi.ts";
import { openDb, warm } from "./db/sql.ts";
import { startPrune } from "./db/prune.ts";
import { setBillingMode, startBilling } from "./db/billing.ts";
import { CHECKPOINT_LOG, startCheckpoints, type CheckpointWorker } from "./db/checkpoints.ts";
import { startSearchUpkeep } from "./db/search-upkeep.ts";
import { checkRestore } from "./db/restore-check.ts";
import { waitForSchema } from "./db/wait.ts";
import { createApp } from "./http/app.ts";
import { receiveOptions, watchBodies } from "./http/receive.ts";
import { shutdown, shutdownDeadlineSeconds } from "./shutdown.ts";

const config = loadConfig();
// Families only, never a wallet: see src/funding/config.ts.
if (config.funding) process.stdout.write(`${fundingConfigLine(config.funding)}\n`);

// Before anything that queries: a platform may start this before the database
// answers, or before the migration runner of the same release has run. The wait is
// on a connection of its own, so the pools below first connect to a database that
// answers, which is what lets warm do its job.
try {
  await waitForSchema(config.db, config.dbWaitSeconds ?? 0);
} catch (error) {
  process.stderr.write(`the service did not start: ${(error as Error).message}\n`);
  process.exit(1);
}

const db = openDb(config);
// Before any other statement: an array parameter is safe only once a pool has
// finished one. See warm in db/sql.ts.
await warm(db);

// WELCOME_SPACE must never name a public SPACE. The grant it switches on enrols
// every KEY that registers, and in a public SPACE that would be a public roster of
// everyone who ever arrived, built without asking them. register_peer already
// refuses to enrol into one, so this is not the guard that keeps the roster
// closed: it tells the operator at boot that the setting does nothing.
if (config.welcomeSpace !== null) {
  const [welcome] = await db.read<{ visibility: string }[]>`
    select visibility from schellingaf.spaces where name = ${config.welcomeSpace}`;
  const refusals: Record<string, string> = {
    public:
      `WELCOME_SPACE is "${config.welcomeSpace}", which is a public SPACE.\n` +
      "Nobody is enrolled into a public SPACE: anyone can already read it, and a grant there would\n" +
      "publish every registering KEY as a member. Leave WELCOME_SPACE unset.\n",
    // Nor a sealed one: a KEY that registers has no encryption key yet, and a sealed
    // SPACE takes no member without one, so every registration would be refused.
    sealed:
      `WELCOME_SPACE is "${config.welcomeSpace}", which is a sealed SPACE.\n` +
      "A KEY that registers has no encryption key yet, and a sealed SPACE takes no member without one,\n" +
      "so every registration would be refused. Name a private SPACE, or leave WELCOME_SPACE unset.\n",
  };
  const refusal = welcome ? refusals[welcome.visibility] : undefined;
  if (refusal !== undefined) {
    process.stderr.write(refusal);
    await db.end();
    process.exit(1);
  }
}

// Before anything can write: the restored chains against every checkpoint the
// service signed. A chain that lost links starts the service read-only, and a log
// that is not there, while the database holds checkpoints, stops the start unless
// CHECKPOINT_LOG_MAY_BE_ABSENT names the token that refusal printed.
const restore = await checkRestore(db, config.logDir, { absentLogToken: config.absentLogToken ?? null });
if (restore.newLog) {
  process.stderr.write(
    `restore check: ${config.logDir}/${CHECKPOINT_LOG} was not there, and CHECKPOINT_LOG_MAY_BE_ABSENT named this database's token, ` +
      "so the service started and began a new log. It holds nothing signed before this start. Unset CHECKPOINT_LOG_MAY_BE_ABSENT, " +
      "or leave it: once the service signs again, it lets nothing through.\n",
  );
}
if (restore.findings.length > 0) {
  config.readOnly = true;
  process.stderr.write(
    `restore check: ${restore.findings.length} chain(s) no longer reach a checkpoint the service signed. ` +
      `Writes are refused until they are recovered: read ${config.logDir}/restore-check.json and runbooks/restore.md.\n`,
  );
  for (const f of restore.findings) {
    process.stderr.write(`  ${f.state} ${f.stream} of SPACE ${f.space_id}: signed through ${f.signed_last}\n`);
  }
}

const app = createApp(config, db);
const port = Number(process.env.PORT ?? 3000);

// How long the server waits while a request arrives: headers within
// HTTP_HEADERS_SECONDS, the whole request within HTTP_REQUEST_SECONDS, and a body that
// sends nothing for HTTP_BODY_IDLE_SECONDS while the server is ready to read it closes
// the connection. See http/receive.ts.
const server = serve({ fetch: app.fetch, port, serverOptions: receiveOptions(config) }, (info) => {
  process.stdout.write(`schellingaf-api listening on ${info.port}, audience ${config.apiHost}\n`);
}) as Server;
watchBodies(server, config.receive!.bodyIdleSeconds * 1000);

// Rate buckets idle for a day and tokens dead for ninety, which are the two
// tables a caller holding no KEY can make grow and this service can shrink. At
// boot and hourly after, under an advisory lock. See db/prune.ts for why each of
// those words is there, and for what registration writes that is never pruned.
startPrune(db);

// Each SPACE over its free allowance is billed for the bytes it stores, once a UTC day, at
// boot and hourly after, from the day the database names; BILLING=shadow takes nothing. See
// db/billing.ts. A set BILLING is written to the database first, where the bill and
// enforcement read it; unset, the database's mode stands. The billing.config line says the
// mode and that day. Never while read-only, as checkpoints are not: it writes the mode, the
// day's bills and its run. A set BILLING that cannot be written stops the service, exit
// code 1: serving on the mode the operator switched away from is the one failure that must
// not pass quietly. Unset, a mode that cannot be read starts no billing.
if (!config.readOnly) {
  try {
    process.stdout.write(`${await setBillingMode(db, config.billing ?? null)}\n`);
    startBilling(db, config.billing ?? null);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (config.billing != null) {
      process.stderr.write(`BILLING=${config.billing} could not be written to the database, so the service stops: ${why}\n`);
      process.exit(1);
    }
    process.stderr.write(`billing not started: ${why}\n`);
  }
}

// The key CryptAPI answers at /pubkey/ now, against the key callbacks are checked with, as
// one funding.pubkey line; never awaited, so a slow provider cannot hold the start. Only
// when deposits are open and the service writes: nothing else may reach the provider.
if (!config.readOnly && depositsOpen(config.funding)) {
  void pubkeyCheckLine(config.funding).then((line) => process.stdout.write(`${line}\n`));
}

// Checkpoints over every chain that has grown, at boot and every minute after, and
// the checkpoint log compacted at boot and daily after. See db/checkpoints.ts, and
// db/restore-check.ts for why each one is also written to the log directory.
// Never while read-only: a checkpoint signed over a chain the restore check found
// short or forked would be logged as the latest, and hide the finding next time.
// Nothing is appended or compacted then either.
const checkpoints: CheckpointWorker | null = config.readOnly ? null : startCheckpoints(db, config.serviceKey!, config.logDir);
if (config.serviceKey!.development) {
  process.stdout.write(
    "service key: none configured, so this process made a development key. What it signs vouches for nothing past a restart.\n",
  );
}

// The search index's pending lists, emptied every SEARCH_INDEX_UPKEEP_SECONDS so a
// SEEK never reads a full one. See db/search-upkeep.ts.
const upkeepSeconds = config.searchUpkeepSeconds ?? 0;
const searchUpkeep = upkeepSeconds > 0 ? startSearchUpkeep(db, upkeepSeconds * 1000) : null;

// Stopping: streams ended, waiting reads answered, the requests under way finished,
// the loops stopped, the request log flushed and the pools ended, within
// SHUTDOWN_DEADLINE_SECONDS. See shutdown.ts. A second signal changes nothing: the
// deadline already bounds the first.
const deadlineMs = shutdownDeadlineSeconds() * 1000;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void shutdown({
      server,
      loops: [
        ...(searchUpkeep ? [{ name: "a search index upkeep pass", stop: () => searchUpkeep.stop() }] : []),
        ...(checkpoints ? [{ name: "a checkpoint pass", stop: () => checkpoints.stop() }] : []),
      ],
      db,
      deadlineMs,
    });
  });
}
