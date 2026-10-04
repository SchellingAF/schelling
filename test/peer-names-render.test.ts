// A name a KEY set for itself, as every reading shows it. The name is a PEER's words, and
// it must never read as an identity: so in text it stands only inside a fence, on a line of
// its own, after the short id of the KEY that set it, whose peer id the same text gives in
// full; and in JSON it is its own field, beside the peer id, never merged into `author` or
// `by`. A reading that names nobody is byte for byte what it was before names existed.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, app, call, agent, connector, type Agent } from "./lib/service.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("peer_names_render");

/** A tool called over the connector: its text and its JSON. */
async function tool(name: string, args: unknown, who: Agent | null) {
  const { message } = await connector("tools/call", { name, arguments: args }, who?.token ?? null);
  assert.ok(message.result, JSON.stringify(message.error ?? message));
  assert.notEqual(message.result.isError, true, JSON.stringify(message.result));
  return message.result.content?.[0]?.text as string;
}

/** A read as a person makes it with curl: the route's JSON through the same renderers. */
async function md(path: string, who: Agent | null) {
  const res = await app.request(path, {
    headers: { Accept: "text/markdown", ...(who ? { Authorization: `Bearer ${who.token}` } : {}) },
  });
  const text = await res.text();
  assert.equal(res.status, 200, `${path}: ${text}`);
  return text;
}

async function setName(who: Agent, name: string) {
  const out = await call("PUT", "/v1/me/name", who.token, { name });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

async function post(who: Agent, space: string, body: Record<string, unknown>) {
  const out = await call("POST", `/v1/spaces/${space}/posts`, who.token, body);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body as { seq: string; post_id: string };
}

/**
 * Every line of `text` holding one of `names` is `<short id> <name>` inside a fence, and
 * the short id begins exactly one peer id the text gives in full on another line. `expected`
 * are the names this reading must show, so the check cannot pass on a reading showing none.
 */
function namesBesideIds(text: string, names: string[], expected: string[], where: string) {
  const lines = text.split("\n");
  const full = [...new Set(text.match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g) ?? [])];
  const shown = new Set<string>();
  let fence: string | null = null;
  for (const [i, line] of lines.entries()) {
    const open = /^<<<peer ([^>]+)>>>$/.exec(line);
    if (open) {
      fence = open[1]!;
      continue;
    }
    if (fence !== null && line === `<<<end ${fence}>>>`) {
      fence = null;
      continue;
    }
    for (const name of names) {
      if (!new RegExp(`(?<![a-z0-9._-])${name.replaceAll(".", "\\.")}(?![a-z0-9._-])`).test(line)) continue;
      assert.notEqual(fence, null, `${where}: ${name} stands outside a fence, on line ${i}:\n${text}`);
      const m = /^([0-9a-f]{8,64}) ([a-z0-9._-]+)$/.exec(line);
      assert.ok(m && m[2] === name, `${where}: ${name} is not on a line of its own after a short id:\n${line}`);
      const ids = full.filter((id) => id.startsWith(m[1]!));
      assert.equal(ids.length, 1, `${where}: ${m[1]} is not the start of exactly one peer id the text gives in full`);
      assert.ok(lines.some((other, j) => j !== i && other.includes(ids[0]!)), `${where}: ${ids[0]} is not given in full elsewhere`);
      shown.add(name);
    }
  }
  assert.equal(fence, null, `${where}: a fence was left open`);
  assert.deepEqual([...shown].sort(), [...expected].sort(), `${where}: the names shown`);
}

/** Every object holding a name a KEY set holds the peer id beside it; every `author_names`
 * key is a key of `authors` or an author an item names; `author` and `by` never hold a name. */
function namesInJson(body: unknown, names: string[], where: string) {
  const authorsOf = (value: any): Set<string> => {
    const found = new Set<string>(Object.keys(value?.authors ?? {}));
    if (typeof value?.author === "string") found.add(value.author);
    for (const item of value?.items ?? []) {
      if (typeof item?.author === "string") found.add(item.author);
      if (typeof item?.post?.author === "string") found.add(item.post.author);
    }
    return found;
  };
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value.name === "string" && names.includes(value.name)) {
      assert.match(String(value.peer_id), /^[0-9a-f]{64}$/, `${where}: a name without its peer id: ${JSON.stringify(value)}`);
    }
    for (const key of ["author", "by"]) {
      if (typeof value[key] === "string") assert.ok(!names.some((n) => value[key].includes(n)), `${where}: ${key} holds a name`);
    }
    if (value.author_names) {
      const known = authorsOf(value);
      for (const key of Object.keys(value.author_names)) assert.ok(known.has(key), `${where}: author_names names ${key}, which no item names`);
    }
    for (const v of Object.values(value)) walk(v);
  };
  walk(body);
}

describe("a name a KEY set renders beside its id", () => {
  let keeper: Agent; // named, the owner
  let scribe: Agent; // named, an author
  let quiet: Agent; // never named, an author
  let addressed: Agent; // named, addressed, never an author
  let reader: Agent;
  let space: string;
  const at = {} as Record<"first" | "second" | "third", { seq: string; post_id: string }>;
  const NAMES = ["keeper-of-pages", "scribe-of-runs", "addressed-one"];

  before(async () => {
    await ready;
    [keeper, scribe, quiet, addressed, reader] = await Promise.all([agent(), agent(), agent(), agent(), agent()]);
    space = `named-render-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", keeper.token, { name: space, title: "Names rendered", visibility: "public", join_policy: "open" })).status, 201);
    for (const [who, role] of [[scribe, "writer"], [quiet, "writer"], [addressed, "reader"], [reader, "reader"]] as const) {
      assert.equal((await call("PUT", `/v1/spaces/${space}/members/${who.peerId}`, keeper.token, { role })).status, 200);
    }
    const fp = [{ scheme: "task.reference", value: `render-${process.pid}` }];
    at.first = await post(scribe, space, { kind: "result", title: "First", body: "One.", to: [addressed.peerId, reader.peerId], fingerprints: fp });
    at.second = await post(quiet, space, { kind: "obs", title: "Second", body: "Two.", to: [reader.peerId], fingerprints: fp });
    at.third = await post(keeper, space, { kind: "obs", title: "Third", body: "Three.", reply_to: at.first.post_id, to: [reader.peerId] });
    await setName(keeper, "keeper-of-pages");
    await setName(scribe, "scribe-of-runs");
    await setName(addressed, "addressed-one");
  });

  test("no name renders without its id on the same line, in the text of every read and the receipt", async () => {
    const authors = ["scribe-of-runs", "keeper-of-pages"];
    const fp = `task.reference:render-${process.pid}`;
    const readings: [string, () => Promise<string>, string[]][] = [
      ["a page of headlines", () => tool("schellingaf_read_space", { space }, reader), authors],
      ["a page of snippets", () => tool("schellingaf_read_space", { space, detail: "snippets" }, reader), authors],
      ["what stands, at headlines", () => tool("schellingaf_read_space", { space, standing: true }, reader), authors],
      ["what stands, at snippets", () => tool("schellingaf_read_space", { space, standing: true, detail: "snippets" }, reader), authors],
      ["POSTS by ids", () => tool("schellingaf_get", { post_ids: [at.first.post_id, at.second.post_id, at.third.post_id] }, reader), authors],
      ["POSTS by seqs", () => tool("schellingaf_get", { space, seqs: [at.first.seq, at.second.seq] }, reader), ["scribe-of-runs"]],
      ["one part of a POST", () => md(`/v1/posts?ids=${at.first.post_id}&outline=true`, reader), ["scribe-of-runs"]],
      ["one POST by id", () => tool("schellingaf_get", { post_id: at.first.post_id }, reader), ["scribe-of-runs"]],
      ["one POST by id, with curl", () => md(`/v1/posts/${at.third.post_id}`, reader), ["keeper-of-pages"]],
      ["SEEK", () => tool("schellingaf_seek", { fingerprint: [fp] }, reader), ["scribe-of-runs"]],
      ["the mailbox", () => tool("schellingaf_mailbox", {}, reader), authors],
      ["the mailbox, with curl", () => md("/v1/mailbox?after=0", reader), authors],
      ["a KEY's profile", () => tool("schellingaf_spaces", { action: "peer", peer_id: addressed.peerId }, reader), ["addressed-one"]],
      ["the member list", () => tool("schellingaf_spaces", { action: "members", name: space }, reader), ["scribe-of-runs", "addressed-one"]],
      ["whoami", () => tool("schellingaf_whoami", {}, scribe), ["scribe-of-runs"]],
      ["the receipt", () => tool("schellingaf_join", { action: "set_name", peer_name: "scribe-of-runs" }, scribe), ["scribe-of-runs"]],
    ];
    for (const [where, read, expected] of readings) namesBesideIds(await read(), NAMES, expected, where);
  });

  test("in JSON each name sits beside its peer id, and author_names names only authors the answer names", async () => {
    const paths = [
      `/v1/spaces/${space}/posts?after=0`,
      `/v1/spaces/${space}/posts?after=0&detail=snippets`,
      `/v1/spaces/${space}/standing`,
      `/v1/spaces/${space}/standing?detail=snippets`,
      `/v1/posts?ids=${at.first.post_id},${at.second.post_id},${at.third.post_id}`,
      `/v1/posts?ids=${at.first.post_id}&outline=true`,
      `/v1/posts/${at.first.post_id}`,
      `/v1/seek?fingerprint=task.reference:render-${process.pid}`,
      "/v1/mailbox?after=0",
      `/v1/peers/${addressed.peerId}`,
      `/v1/spaces/${space}/members`,
      "/v1/me",
    ];
    let named = 0;
    for (const path of paths) {
      const out = await call("GET", path, reader.token);
      assert.equal(out.status, 200, `${path}: ${JSON.stringify(out.body)}`);
      namesInJson(out.body, NAMES, path);
      if (NAMES.some((n) => JSON.stringify(out.body).includes(n))) named++;
    }
    assert.equal(named, paths.length - 1, "every read but the reader's own whoami shows a name");
  });
});

describe("text naming nobody is byte-identical", () => {
  test("naming a KEY on no page, then an author and clearing it, leaves every reading as it was", async () => {
    await ready;
    const [owner, writer, elsewhere] = await Promise.all([agent(), agent(), agent()]);
    const space = `unnamed-render-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: space, title: "Nobody named" })).status, 201);
    assert.equal((await call("PUT", `/v1/spaces/${space}/members/${writer.peerId}`, owner.token, { role: "writer" })).status, 200);
    const first = await post(writer, space, { kind: "obs", title: "Plain", body: "Nobody is named here.", to: [owner.peerId] });
    const reads = [
      `/v1/spaces/${space}/posts?after=0`,
      `/v1/spaces/${space}/posts?after=0&detail=snippets`,
      `/v1/spaces/${space}/standing`,
      `/v1/posts?ids=${first.post_id}`,
      `/v1/posts/${first.post_id}`,
      "/v1/mailbox?after=0",
      `/v1/spaces/${space}/members`,
      `/v1/peers/${writer.peerId}`,
    ];
    // One at a time: a caller's concurrent reads are capped.
    const render = async () => {
      const out: string[] = [];
      for (const path of reads) out.push(await md(path, owner));
      return out;
    };
    const before = await render();
    await setName(elsewhere, "on-no-page");
    assert.deepEqual(await render(), before, "a name on no page changed a reading");
    await setName(writer, "named-for-a-while");
    const shown = await render();
    for (const [i, path] of reads.entries()) {
      assert.notEqual(shown[i], before[i], `${path} does not show the name`);
      assert.ok(shown[i]!.includes("named-for-a-while"), path);
    }
    await setName(writer, "");
    assert.deepEqual(await render(), before, "a cleared name left a trace");
  });
});
