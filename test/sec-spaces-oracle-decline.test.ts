// Declining an offer of a seat tells a KEY outside the SPACE nothing of the SPACE's
// counters.
//
// An offer reaches any KEY that knows its maker, a member of the SPACE or not. A private
// SPACE's revision is one of its counters, which only its members read (space_heads()).
// Declining answers whether the offer ended; to a KEY that is no member it never answers
// the revision, the first time or any time after, when a decline of an offer long gone
// would otherwise read the SPACE's governance moving for as long as the offer's row lasts.
// The request log still records the revision, as it records every write's. A public
// SPACE's revision is every reader's, so there anybody who declines is answered it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, call, agent, fixture, type Agent } from "./lib/service.ts";

useService("sec_so_decline");

async function makeSpace(owner: Agent, name: string, visibility = "private") {
  const made = await call("POST", "/v1/spaces", owner, { name, title: `The ${name} space`, join_policy: "invite", visibility });
  assert.equal(made.status, 201, JSON.stringify(made.body));
}

async function grant(space: string, by: Agent, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${space}/members/${who.peerId}`, by, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

describe("declining an offer", () => {
  test("a KEY outside the SPACE is never told its revision", async () => {
    const owner = await agent();
    await makeSpace(owner, "quiet-space");
    const maker = await agent();
    await grant("quiet-space", owner, maker, "writer");
    // The KEY offered the seat knows its maker from another SPACE, and is no member here.
    const outsider = await agent();
    await makeSpace(maker, "meeting-space");
    await grant("meeting-space", maker, outsider, "reader");
    const offered = await call("POST", "/v1/spaces/quiet-space/hand-over", maker, { to: outsider.peerId });
    assert.equal(offered.status, 201, JSON.stringify(offered.body));
    const profile = await call("GET", "/v1/spaces/quiet-space", outsider);
    assert.equal(profile.body.revision, undefined, "the profile gives a stranger no revision");

    const declined = await call("POST", `/v1/hand-overs/${offered.body.offer_id}/decline`, outsider);
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.changed, true);
    assert.equal(declined.body.revision, undefined, JSON.stringify(declined.body));

    // The SPACE goes on, and a decline of the same offer, long after, reads none of it.
    await grant("quiet-space", owner, await agent(), "reader");
    const again = await call("POST", `/v1/hand-overs/${offered.body.offer_id}/decline`, outsider);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.changed, false);
    assert.equal(again.body.revision, undefined, JSON.stringify(again.body));

    // The function still hands the api the revision, marked outside, so the request log
    // records it as it records every write's.
    const [row] = await fixture.owner<{ declined: any }[]>`
      select schellingaf.decline_hand_over(${offered.body.offer_id}::uuid, ${Buffer.from(outsider.peerId, "hex")}) as declined`;
    assert.equal(row!.declined.outside, true);
    assert.match(row!.declined.revision, /^[1-9][0-9]*$/);
  });

  test("a KEY outside a public SPACE is answered its revision, as every reader reads it", async () => {
    const owner = await agent();
    await makeSpace(owner, "open-book", "public");
    const maker = await agent();
    await grant("open-book", owner, maker, "writer");
    const outsider = await agent();
    await makeSpace(maker, "open-meeting");
    await grant("open-meeting", maker, outsider, "reader");
    const offered = await call("POST", "/v1/spaces/open-book/hand-over", maker, { to: outsider.peerId });
    assert.equal(offered.status, 201, JSON.stringify(offered.body));

    const declined = await call("POST", `/v1/hand-overs/${offered.body.offer_id}/decline`, outsider);
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(declined.body.changed, true);
    assert.equal(declined.body.outside, undefined, JSON.stringify(declined.body));
    const profile = await call("GET", "/v1/spaces/open-book", outsider);
    assert.equal(declined.body.revision, profile.body.revision, JSON.stringify(declined.body));
    const again = await call("POST", `/v1/hand-overs/${offered.body.offer_id}/decline`, outsider);
    assert.equal(again.body.changed, false);
    assert.equal(again.body.revision, profile.body.revision, JSON.stringify(again.body));
  });

  test("a member who declines is answered as before, revision and all", async () => {
    const owner = await agent();
    await makeSpace(owner, "member-space");
    const maker = await agent();
    await grant("member-space", owner, maker, "writer");
    const reader = await agent();
    await grant("member-space", owner, reader, "reader");
    const offered = await call("POST", "/v1/spaces/member-space/hand-over", maker, { to: reader.peerId });
    assert.equal(offered.status, 201, JSON.stringify(offered.body));
    const declined = await call("POST", `/v1/hand-overs/${offered.body.offer_id}/decline`, reader);
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    const profile = await call("GET", "/v1/spaces/member-space", reader);
    assert.equal(declined.body.revision, profile.body.revision);
    assert.equal(declined.body.changed, true);
  });
});
