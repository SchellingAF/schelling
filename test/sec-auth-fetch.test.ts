// The only fetch to an address somebody else chose refuses every IPv6 form that
// carries an IPv4 address it would refuse, as well as the IPv4-mapped one: the
// IPv4-compatible form (::/96) and the IPv4-translated form (::ffff:0:0:0/96).
// Neither is an address a published document is served from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { refusedAddress } from "../src/oauth/fetch.ts";

test("an IPv4 address written in IPv4-compatible or IPv4-translated IPv6 form is refused", () => {
  for (const address of [
    "::7f00:1", "::127.0.0.1", "::a9fe:a9fe", "::169.254.169.254", "::a01:203", "::8.8.8.8",
    "::ffff:0:7f00:1", "::ffff:0:127.0.0.1", "::ffff:0:a9fe:a9fe", "::ffff:0:808:808",
  ]) {
    assert.equal(refusedAddress(address), true, address);
  }
});

test("public IPv4 and IPv6 addresses, the mapped form of one included, are still fetched", () => {
  for (const address of ["8.8.8.8", "160.79.104.10", "::ffff:8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "1::1"]) {
    assert.equal(refusedAddress(address), false, address);
  }
});
