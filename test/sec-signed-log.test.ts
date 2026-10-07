// The checkpoint log a restore check reads after a crash. An append cut short by a crash
// leaves a last line with no end; the restore check skips that line, and the next
// checkpoint the service signs must still stand on a line of its own, or the check would
// skip it too and compare a restored chain with an older checkpoint than the service
// signed.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { useService, db, fixture, call, agent } from "./lib/service.ts";
import { makeCheckpoints, latestSigned, CHECKPOINT_LOG } from "../src/db/checkpoints.ts";
import { developmentServiceKey } from "../src/domain/service.ts";

const key = developmentServiceKey();
const logDir = mkdtempSync(path.join(tmpdir(), "schellingaf-sec-log-"));

useService("sec_signed_log", { serviceKey: key });
after(() => {
  rmSync(logDir, { recursive: true, force: true });
});

describe("a checkpoint signed after an append was cut short", () => {
  test("stands on a line of its own, so the restore check reads it", async () => {
    const owner = await agent();
    const name = `log-${randomUUID().slice(0, 8)}`;
    const [row] = await fixture.owner<{ created: { space_id: string } }[]>`
      select schellingaf.create_space(${Buffer.from(owner.peerId, "hex")}, ${name}, ${"Logged"}, ${""}, ${"invite"}, ${"public"}) as created`;
    const spaceId = row!.created.space_id;
    assert.equal((await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", body: "one" })).status, 201);

    // The log as a crash mid-append leaves it: a last line with no end.
    const file = path.join(logDir, CHECKPOINT_LOG);
    const cut = `{"checkpoint_id":"${"ab".repeat(32)}","space_id":"${randomUUID()}","stream":"po`;
    writeFileSync(file, cut);

    const run = await makeCheckpoints(db, key, { minAgeSeconds: 0, logDir });
    assert.ok(run.state === "done" && run.made > 0, JSON.stringify(run));

    const latest = await latestSigned(file);
    // The SPACE's events, signed first, and its posts: each is read.
    for (const stream of ["events", "posts"]) {
      assert.ok(latest?.has(`${spaceId}/${stream}`), `the ${stream} checkpoint signed after the cut line is not read`);
    }
    // The cut line is still there, as it was, and still skipped.
    assert.ok(readFileSync(file, "utf8").startsWith(`${cut}\n`));
  });
});
