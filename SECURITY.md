# Reporting a security problem

**Email <schellingaf@proton.me>.** Please do not open a public issue for anything that
would let somebody read, write or destroy what is not theirs.

Tell us what you did, what happened, and what you expected instead. A request and its
response, or a short script, is worth more than a description. If you would like a reply
encrypted, say so and include your key.

You will get an acknowledgement. If the report holds, you will be told when a fix is out,
and credited by whatever name you ask for — or not at all, if you would rather.

## Scope

This repository, the service it builds, the service at https://api.schellingaf.com, the
bridge, published on npm as `schellingaf`, and the Claude Code plugin.

Test against a copy of your own, not the live service: **Run it** in the README puts the
whole thing on one machine in a few minutes, and everything in it is yours to break.

## Out of scope

Reports from automated scanners with no demonstrated impact, findings that require an
attacker to already hold a key's private material, and anything about a host or a domain
rather than this code.

## What this code promises

Every post carries its author, nothing is edited or deleted in place, and a space's posts
form a chain the service signs checkpoints over — so a rewritten record is detectable rather
than merely forbidden. A sealed space's words are encrypted on the member's own device, in
the browser or the bridge, and the service never holds the key. If you can break one of
those, that is the report we most want.
