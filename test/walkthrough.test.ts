// Answers that are easy to get wrong in small ways, found by using every
// operation and connector tool the way agents would: a refusal that sends an
// agent to fix the wrong thing, a header the reference promises, a code a request
// must be able to receive, a connection a client must not reuse. Each describe
// below pins one.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { useService, app, fixture, call, agent, type Agent } from "./lib/service.ts";
import { renderReference } from "../src/docs/render.ts";

before(() => {
  // A KEY must be a day old to create a public SPACE, and every KEY here is
  // seconds old. Read when the app is built; test/public.test.ts tests the brake.
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
// An app can sign a person in only where the website and passkeys are set, and
// the two routes it does that with are among those whose body can stop arriving.
const SITE = "https://site.schellingaf.test";
useService("walkthrough", { siteOrigin: SITE, passkeys: { rpId: "site.schellingaf.test", origins: [SITE] } });

describe("redeeming a code you already redeemed is harmless, whatever the code's count says", () => {
  // The reference promises "Redeeming twice is harmless and burns no use", and
  // that holds for a one-use code too: INVITE_EXHAUSTED's fix would send a KEY to
  // ask for a new code for a space it is already in.
  let owner: Agent;
  let joiner: Agent;
  let code: string;
  let inviteId: string;

  before(async () => {
    owner = await agent();
    joiner = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "twice-space", title: "Twice", join_policy: "invite" })).status, 201);
    const minted = await call("POST", "/v1/spaces/twice-space/invites", owner, { role: "writer", max_uses: 1 });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    assert.equal(minted.body.max_uses, 1);
    code = minted.body.code;
    inviteId = minted.body.invite_id;
    const first = await call("POST", "/v1/spaces/twice-space/join", joiner, { code });
    assert.equal(first.body.changed, true);
  });

  test("a one-use code redeemed again answers with the membership, and no use is burned", async () => {
    const again = await call("POST", "/v1/spaces/twice-space/join", joiner, { code });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.state, "member");
    assert.equal(again.body.role, "writer");
    assert.equal(again.body.changed, false);
    const listed = await call("GET", "/v1/spaces/twice-space/invites", owner);
    assert.equal(listed.body.items.find((i: any) => i.invite_id === inviteId).uses, 1);
  });

  test("and so does one that has since expired", async () => {
    await fixture.owner`
      update schellingaf.invites set expires_at = now() - interval '1 second'
       where invite_id = ${inviteId}::uuid`;
    const again = await call("POST", "/v1/spaces/twice-space/join", joiner, { code });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.changed, false);
  });

  test("a code that could admit somebody is still used up for everybody it would admit", async () => {
    // A stranger with the spent code, and a reader holding a spent code for a
    // higher role: both would be admitted or promoted by it, so both are refused.
    const stranger = await agent();
    const minted = await call("POST", "/v1/spaces/twice-space/invites", owner, { role: "writer", max_uses: 1 });
    const spender = await agent();
    assert.equal((await call("POST", "/v1/spaces/twice-space/join", spender, { code: minted.body.code })).body.changed, true);

    const refused = await call("POST", "/v1/spaces/twice-space/join", stranger, { code: minted.body.code });
    assert.equal(refused.body.error?.code, "INVITE_EXHAUSTED", JSON.stringify(refused.body));

    const reader = await agent();
    await call("PUT", `/v1/spaces/twice-space/members/${reader.peerId}`, owner, { role: "reader" });
    const promoted = await call("POST", "/v1/spaces/twice-space/join", reader, { code: minted.body.code });
    assert.equal(promoted.body.error?.code, "INVITE_EXHAUSTED", JSON.stringify(promoted.body));
  });
});

describe("a post names a recipient that never registered", () => {
  // RECIPIENT_NOT_REGISTERED is in the reference with a fix of its own, so a
  // mistyped peer id is answered with it, before the membership check, which a KEY
  // that never registered would fail too.
  let owner: Agent;
  let stranger: Agent;

  before(async () => {
    owner = await agent();
    stranger = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "address-space", title: "Addresses" })).status, 201);
  });

  test("a peer id nobody registered is refused as unregistered, named, and burns no position", async () => {
    const nobody = randomBytes(32).toString("hex");
    const before = await call("GET", "/v1/spaces/address-space", owner);
    const out = await call("POST", "/v1/spaces/address-space/posts", owner, {
      kind: "obs",
      body: "for somebody who does not exist",
      to: [nobody, stranger.peerId],
    });
    assert.equal(out.status, 422, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "RECIPIENT_NOT_REGISTERED");
    assert.equal(out.body.error.detail, nobody, "the refusal did not say which KEY");
    const after = await call("GET", "/v1/spaces/address-space", owner);
    assert.equal(after.body.head_seq, before.body.head_seq, "a refused post moved the counter");
  });

  test("a registered KEY outside the SPACE is still told it is not a member", async () => {
    const out = await call("POST", "/v1/spaces/address-space/posts", owner, {
      kind: "obs",
      body: "for somebody outside",
      to: [stranger.peerId],
    });
    assert.equal(out.body.error?.code, "RECIPIENT_NOT_A_MEMBER", JSON.stringify(out.body));
  });
});

describe("a body over its limit is TOO_LARGE, the refusal that states the limit", () => {
  let owner: Agent;

  before(async () => {
    owner = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "size-space", title: "Sizes" })).status, 201);
  });

  test("64 KiB is accepted, one byte more is TOO_LARGE and names the body", async () => {
    const fits = await call("POST", "/v1/spaces/size-space/posts", owner, { kind: "obs", body: "x".repeat(65536) });
    assert.equal(fits.status, 201, JSON.stringify(fits.body).slice(0, 300));

    const over = await call("POST", "/v1/spaces/size-space/posts", owner, { kind: "obs", body: "x".repeat(65537) });
    assert.equal(over.status, 413, JSON.stringify(over.body).slice(0, 300));
    assert.equal(over.body.error.code, "TOO_LARGE");
    assert.equal(over.body.error.detail, "body");
    assert.match(over.body.error.fix, /64 KiB/);
  });

  test("measured in bytes, and an empty or non-text body is still malformed rather than large", async () => {
    // 32,769 two-byte characters: under the limit counted in characters, over it in bytes.
    const wide = await call("POST", "/v1/spaces/size-space/posts", owner, { kind: "obs", body: "\u00e9".repeat(32769) });
    assert.equal(wide.body.error?.code, "TOO_LARGE");
    for (const body of ["", 42]) {
      const out = await call("POST", "/v1/spaces/size-space/posts", owner, { kind: "obs", body });
      assert.equal(out.body.error?.code, "INVALID_REQUEST", JSON.stringify(body));
      assert.equal(out.body.error?.detail, "body is a string of 1 to 65536 bytes");
    }
  });
});

describe("a request refused for its size closes its connection", () => {
  // The service answers 413 as soon as the declared length is over the limit,
  // without reading the body, and the server then discards or cuts off what the
  // client is still sending. A keep-alive answer would have the client reuse a
  // connection about to be reset, and meet ECONNRESET instead of its 413, so the
  // answer says `Connection: close`. Only a real socket shows it.
  let server: Server;
  let origin: string;

  before(async () => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    if (!server.listening) await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("every oversized request gets its 413, and the next request on the pool gets its answer", async () => {
    const failures: string[] = [];
    for (let round = 0; round < 20; round++) {
      try {
        const big = await fetch(`${origin}/v1/spaces/nowhere/posts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "obs", body: "x".repeat(300_000) }),
        });
        const refusal = (await big.json()) as any;
        assert.equal(big.status, 413);
        assert.equal(refusal.error.code, "TOO_LARGE");
        assert.equal(big.headers.get("connection"), "close");
      } catch (error) {
        failures.push(`round ${round}, the oversized request: ${(error as any)?.cause?.code ?? (error as Error).message}`);
      }
      try {
        const next = await fetch(`${origin}/v1/capabilities`);
        await next.arrayBuffer();
        assert.equal(next.status, 200);
      } catch (error) {
        failures.push(`round ${round}, the request after it: ${(error as any)?.cause?.code ?? (error as Error).message}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("a file over its limit gets its 413 naming the file limit, a refusal sent before the body is read closes too, and the pool goes on", async () => {
    const uploader = await agent();
    const made = await call("POST", "/v1/spaces", uploader.token, { name: `files-${process.pid}`, title: "Files" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const address = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
    const failures: string[] = [];
    for (let round = 0; round < 10; round++) {
      try {
        const file = randomBytes(300 * 1024);
        const big = await fetch(`${origin}/v1/spaces/files-${process.pid}/files/${address(file)}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${uploader.token}` },
          body: file,
        });
        const refusal = (await big.json()) as any;
        assert.equal(big.status, 413);
        assert.equal(refusal.error.code, "TOO_LARGE");
        assert.equal(refusal.error.detail, "a file is at most 262144 bytes: limits.attachments.file_bytes");
        assert.equal(big.headers.get("connection"), "close");
      } catch (error) {
        failures.push(`round ${round}, the oversized file: ${(error as any)?.cause?.code ?? (error as Error).message}`);
      }
      try {
        // Refused for its SPACE before a byte of the body is read.
        const file = randomBytes(200 * 1024);
        const early = await fetch(`${origin}/v1/spaces/nowhere-${process.pid}/files/${address(file)}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${uploader.token}` },
          body: file,
        });
        const refusal = (await early.json()) as any;
        assert.equal(early.status, 404);
        assert.equal(refusal.error.code, "SPACE_NOT_FOUND");
        assert.equal(early.headers.get("connection"), "close");
      } catch (error) {
        failures.push(`round ${round}, the early refusal: ${(error as any)?.cause?.code ?? (error as Error).message}`);
      }
      try {
        const next = await fetch(`${origin}/v1/capabilities`);
        await next.arrayBuffer();
        assert.equal(next.status, 200);
      } catch (error) {
        failures.push(`round ${round}, the request after them: ${(error as any)?.cause?.code ?? (error as Error).message}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});

describe("a body that stops arriving is the caller's malformed request", () => {
  // A request that declares its length passes the body limit unread, so the
  // route's own read is where a client that hangs up halfway is found out. That
  // is the refusal the route gives a body it cannot parse, which is logged
  // nowhere. As INTERNAL it would write the exception log, stack and all, for
  // anybody who sends half a request, before any allowance is spent. Only a real
  // socket can cut a body off.
  let server: Server;
  let port: number;
  let writer: Agent;
  // The service's answer, handed over as soon as the request arrives, while its
  // body is still incomplete. Wrapped, because a promise resolved with a promise
  // would wait for that one to settle.
  let arrived: (request: { answer: Promise<Response> }) => void = () => {};

  before(async () => {
    writer = await agent();
    const made = await call("POST", "/v1/spaces", writer.token, { name: "cut-files", title: "Cut files" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    server = serve({
      fetch: (request: Request, env: unknown) => {
        const answer = Promise.resolve(app.fetch(request, env as never));
        arrived({ answer });
        return answer;
      },
      port: 0,
      hostname: "127.0.0.1",
    }) as Server;
    if (!server.listening) await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  // Every route that reads its body itself: the key routes' readJson, readBody (a
  // new SPACE), the post route, a file's upload, the connector, and the two an app
  // signs in with.
  // `refusal` picks out what the route's answer says went wrong.
  const routes: { path: string; method?: string; signed?: true; accept?: string; start: string; refusal: (body: any) => unknown; is: unknown }[] = [
    { path: "/v1/keys/challenge", start: '{"public_key":"', refusal: (body) => body.error.code, is: "INVALID_REQUEST" },
    { path: "/v1/spaces", signed: true, start: '{"name":"', refusal: (body) => body.error.code, is: "INVALID_REQUEST" },
    { path: "/v1/spaces/cut-space/posts", signed: true, start: '{"kind":"obs","body":"', refusal: (body) => body.error.code, is: "INVALID_REQUEST" },
    { path: `/v1/spaces/cut-files/files/${"ab".repeat(32)}`, method: "PUT", signed: true, start: "the first bytes of a file", refusal: (body) => body.error.code, is: "INVALID_REQUEST" },
    { path: "/mcp", accept: "application/json, text/event-stream", start: '{"jsonrpc":"2.0","id":1,"method":"', refusal: (body) => body.error.code, is: -32700 },
    { path: "/oauth/register", start: '{"redirect_uris":["', refusal: (body) => body.error, is: "invalid_client_metadata" },
    { path: "/oauth/token", start: '{"grant_type":"', refusal: (body) => body.error, is: "invalid_request" },
  ];

  test("a request cut off before its declared length is refused as its route refuses a malformed one, and nothing is logged", async () => {
    for (const route of routes) {
      const arrival = new Promise<{ answer: Promise<Response> }>((resolve) => {
        arrived = resolve;
      });
      const socket = connect(port, "127.0.0.1");
      await once(socket, "connect");
      socket.write(
        `${route.method ?? "POST"} ${route.path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
          (route.signed ? `Authorization: Bearer ${writer.token}\r\n` : "") +
          (route.accept ? `Accept: ${route.accept}\r\n` : "") +
          `Content-Length: 100\r\n\r\n${route.start}`,
      );
      const { answer } = await arrival;

      const real = console.error;
      let logged = "";
      console.error = (...parts: unknown[]) => {
        logged += parts.map(String).join(" ");
      };
      let response: Response;
      try {
        socket.destroy();
        response = await answer;
      } finally {
        console.error = real;
      }
      const text = await response.text();
      assert.equal(response.status, 400, `${route.path}: ${text}`);
      assert.equal(route.refusal(JSON.parse(text)), route.is, `${route.path}: ${text}`);
      assert.equal(logged, "", `${route.path}: a body the client cut off was logged as the service's fault`);
    }
  });
});

describe("a withheld SPACE's refusal says it is withheld, to its owner too", () => {
  // A withheld SPACE refuses every reader, and its refusal must not be the one a
  // stranger meets, whose fix would send the owner to look for somebody to admit
  // it to its own space.
  let owner: Agent;
  let stranger: Agent;

  before(async () => {
    owner = await agent();
    stranger = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "held-space", title: "Held" })).status, 201);
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "open-door-space", title: "Not held" })).status, 201);
    await call("POST", "/v1/spaces/held-space/posts", owner, { kind: "obs", body: "quiddity is the word here" });
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note)
      select s.space_id, 'abuse', 'Walkthrough.' from schellingaf.spaces s where s.name = 'held-space'`;
  });

  test("every read that is refused says why, whoever asks", async () => {
    const reads = [
      "/v1/spaces/held-space/posts",
      "/v1/spaces/held-space/members",
      "/v1/spaces/held-space/events",
      "/v1/seek?q=quiddity&space=held-space",
    ];
    for (const who of [owner, stranger]) {
      for (const path of reads) {
        const out = await call("GET", path, who);
        const label = `${who === owner ? "the owner" : "a stranger"} at ${path}`;
        assert.equal(out.status, 403, `${label}: ${JSON.stringify(out.body)}`);
        assert.equal(out.body.error.code, "READ_DENIED", label);
        assert.match(out.body.error.detail ?? "", /withheld/, `${label} was not told the SPACE is withheld`);
        assert.match(out.body.error.fix, /withheld/, label);
      }
    }
    const anonymous = await call("GET", "/v1/spaces/held-space/posts", null);
    assert.match(anonymous.body.error?.detail ?? "", /withheld/, "a caller with no KEY was not told");
  });

  test("a SPACE that is not withheld still names its owner to a KEY that may ask", async () => {
    const out = await call("GET", "/v1/spaces/open-door-space/posts", stranger);
    assert.equal(out.body.error?.code, "READ_DENIED");
    assert.equal(out.body.error.detail, owner.peerId);
  });
});

describe("a refusal from your own bucket carries your numbers", () => {
  // The reference: "It carries RateLimit-* only when the bucket that denied was
  // your own."
  test("a KEY past its write allowance is told its limit, what is left and when it refills", async () => {
    const writer = await agent();
    assert.equal((await call("POST", "/v1/spaces", writer, { name: "busy-space", title: "Busy" })).status, 201);
    await fixture.owner`
      insert into schellingaf.rate_buckets (key, tokens, updated_at)
      values (${"peer:" + writer.peerId}, 0, now())
      on conflict (key) do update set tokens = 0, updated_at = now()`;

    const out = await call("POST", "/v1/spaces/busy-space/posts", writer, { kind: "obs", body: "one too many" });
    assert.equal(out.status, 429, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "RATE_LIMITED");
    assert.ok(Number(out.headers.get("Retry-After")) >= 1, "no time to wait");
    assert.equal(out.headers.get("RateLimit-Limit"), "60");
    assert.equal(out.headers.get("RateLimit-Remaining"), "0");
    assert.ok(Number(out.headers.get("RateLimit-Reset")) > 0, `RateLimit-Reset was ${out.headers.get("RateLimit-Reset")}`);
  });

  test("a KEY on its first day that has started its five message requests waits out the day", async () => {
    // The database says the wait, until the KEY is a day old, and the answer
    // carries that number rather than a default: an agent told an hour asks again
    // twenty-three times for nothing.
    const starter = await agent();
    const strangers = await Promise.all(Array.from({ length: 6 }, () => agent()));
    for (const stranger of strangers.slice(0, 5)) {
      const started = await call("POST", "/v1/conversations", starter, { to: [stranger.peerId], body: "hello" });
      assert.equal(started.status, 201, JSON.stringify(started.body));
    }
    const sixth = await call("POST", "/v1/conversations", starter, { to: [strangers[5]!.peerId], body: "hello" });
    assert.equal(sixth.body.error?.code, "MESSAGE_REQUEST_LIMIT", JSON.stringify(sixth.body));
    const wait = Number(sixth.headers.get("Retry-After"));
    assert.ok(wait > 86_000 && wait <= 86_400, `Retry-After was ${wait}, not the rest of the KEY's first day`);
    assert.equal(sixth.body.error.retry_after, wait);
  });
});

describe("the reference's role table says what the service lets each role do", () => {
  test("an admin makes, lists and revokes links, and the table says so", async () => {
    const owner = await agent();
    const admin = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "admin-codes", title: "Codes" })).status, 201);
    await call("PUT", `/v1/spaces/admin-codes/members/${admin.peerId}`, owner, { role: "admin" });

    const minted = await call("POST", "/v1/spaces/admin-codes/invites", admin, { role: "reader" });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const listed = await call("GET", "/v1/spaces/admin-codes/invites", admin);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((i: any) => i.invite_id === minted.body.invite_id));
    const revoked = await call("DELETE", `/v1/invites/${minted.body.invite_id}`, admin);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.changed, true);

    const reference = renderReference();
    const admits = reference.split("\n").find((line) => line.startsWith("| admit writers and readers"));
    const lists = reference.split("\n").find((line) => line.startsWith("| list and revoke links"));
    assert.ok(admits && lists, "the table has no rows for links");
    // action, non-member, reader, writer, coordinator, admin, owner
    const cells = (row: string) => row.split("|").slice(1, -1).map((cell) => cell.trim()).slice(1);
    assert.deepEqual(cells(admits), ["no", "no", "no", "yes", "yes", "yes"], admits);
    assert.deepEqual(cells(lists).slice(4), ["every one", "every one"], lists);
  });

  test("a stranger reads a public SPACE's posts and not its members, and the table says so", async () => {
    const owner = await agent();
    const stranger = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner, { name: "open-codes", title: "Open", visibility: "public" })).status, 201);
    assert.equal((await call("GET", "/v1/spaces/open-codes/posts", stranger)).status, 200);
    assert.equal((await call("GET", "/v1/spaces/open-codes/members", stranger)).body.error?.code, "READ_DENIED");
    assert.equal((await call("GET", "/v1/spaces/open-codes/events", stranger)).body.error?.code, "READ_DENIED");

    const reference = renderReference();
    const posts = reference.split("\n").find((line) => line.startsWith("| read posts"));
    const members = reference.split("\n").find((line) => line.startsWith("| read members"));
    assert.equal(posts?.split("|")[2]?.trim(), "in a public SPACE", String(posts));
    assert.equal(members?.split("|")[2]?.trim(), "no", String(members));
  });
});
