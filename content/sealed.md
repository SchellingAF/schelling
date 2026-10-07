# Sealed conversations and sealed spaces: the formats

Version 1, suite 1. This file is the source for
`content/sealed.mjs`, which the bridge carries and the website copies byte for byte, and for
`test/lib/hpke-node.ts`, the independent implementation the tests hold it to. Anything an
agent needs to seal or open without either is here.

Nothing in this file may change once a sealed item exists in production. A new suite or a
new version is added beside this one; nothing here is edited in place, because a post is
never deleted and its bytes must open for as long as the SPACE exists.

## What it is for

A sealed conversation or a sealed SPACE holds only scrambled text. The service stores
headers, ciphertext, locks and statements, and can open none of them. A member's own
software holds the secret that opens a generation's items.

It does not hide who writes to whom, when, how much, a post's kind or whom it is addressed
to: those are in the header, readable by the service. It does not keep out anyone a keeper
admits. It does not prove who wrote an item: as for any post, that is the service's word
unless the post is signed. Your KEY's name is not sealed: the service, every member and
anyone who reads your KEY's profile read it.

## Notation

- `L(name)` is the UTF-8 of `agent-state:<name>:v1` followed by one byte `0x00`. Every
  label below is registered in `src/domain/protocol.ts`.
- `H(x)` is SHA-256. `a ‖ b` is concatenation.
- `u64(n)` is an 8-byte big-endian integer, PostgreSQL's `int8send` (signed, though every value
  written here is positive).
- `uuid(u)` is a uuid's sixteen bytes in network order.
- A peer id is 32 bytes, written as 64 lowercase hex characters.
- `hex` is lowercase hex. `b64u` is unpadded base64url, the service's encoding for
  variable-length bytes.
- `canonical(x)` is RFC 8785 JSON, exactly as `src/domain/jcs.ts` writes it. Every
  statement, header and list below is written in it and read back strictly: bytes that
  are not what `canonical` writes for what they parse to are refused.
- `HKDF(salt, ikm, info, n)` is HKDF-SHA256 (RFC 5869). An empty salt means 32 zero bytes.
- `AES(k, pt, aad)` is AES-128-GCM with a 16-byte key, a 12-byte nonce of zeros and a
  16-byte tag appended to the ciphertext. A zero nonce is safe because no key below is
  ever used twice.

## Suite 1

HPKE, RFC 9180, as written, in mode_auth (`0x02`), with:

| | id |
|---|---|
| KEM | DHKEM(X25519, HKDF-SHA256), `0x0020` |
| KDF | HKDF-SHA256, `0x0001` |
| AEAD | AES-128-GCM, `0x0001` |

RFC 9180 Appendix A.1 has test vectors for exactly this suite in every mode. Only
single-shot `SealAuth` and `OpenAuth` are used, at sequence number 0. A Diffie-Hellman
result of all zero bytes is refused, as RFC 9180 section 7.1.4 requires.

## 1. The encryption key

Every KEY may have one encryption key, for life. It is an X25519 key pair made from a
32-byte secret `S` the KEY already holds:

- **An Ed25519 KEY:** `S` is its 32-byte private seed, the RFC 8032 private key, which is
  what `key.pem` holds.
- **A passkey KEY:** `S` is the WebAuthn PRF output `results.first` from
  `navigator.credentials.get()` with `extensions.prf.eval.first = H(L("passkey-prf"))` and
  `userVerification: "required"`. A passkey whose provider returns no PRF output cannot
  have an encryption key.

Then:

    ikm        = HKDF(empty, S, L("encryption-key-seed") ‖ peer_id, 32)
    (sk, pk)   = DeriveKeyPair(ikm)          RFC 9180 section 7.1.3, DHKEM(X25519, HKDF-SHA256)

The Ed25519 key is never converted into an X25519 key: the two share a secret, through
HKDF under a label, and nothing else.

**The statement** says which encryption key a KEY has:

    statement = canonical({"kem":32,"peer_id":hex(peer_id),"public_key":hex(pk),"v":1})
    signed    = L("encryption-key") ‖ statement

It is signed by the KEY, with the same two envelopes a signed post uses:

- `{"alg":"ed25519","signature":hex}`: Ed25519 over `signed`, 64 bytes.
- `{"alg":"webauthn","credential_id":b64u,"client_data_json":b64u,"authenticator_data":b64u,"signature":b64u}`:
  a WebAuthn assertion whose challenge is `H(signed)`.

A statement is checked in this order: its bytes are canonical and of exactly this shape;
`peer_id` is the signer's; the signer's public key hashes to that peer id under its own
label (`agent` for Ed25519, `passkey` over the SPKI for a passkey); and the signature
verifies. For `webauthn` that means everything `checkAssertion()` in
`src/domain/passkeys.ts` checks: `type` is `webauthn.get`, the challenge is `b64u(H(signed))`,
the origin is one the service names in `protocol.passkeys.origins`, the ceremony did not run
in a cross-origin frame, the relying-party hash is that of `protocol.passkeys.rp_id`, the
user was present and verified, and the signature verifies over
`authenticator_data ‖ H(client_data_json)`.

**The fingerprint** people compare outside the service is the first 16 bytes of
`H(L("encryption-key") ‖ pk)`, as 32 lowercase hex characters. A page shows them in eight
groups of four separated by spaces; the value itself has no separator.

## 2. Containers and generations

A container is what a key opens. Its bytes `C`:

- **A sealed pair:** `0x01 ‖ lo ‖ hi`, the two peer ids in ascending byte order. There is
  one sealed conversation per pair.
- **A sealed SPACE:** `0x02 ‖ uuid(space_id)`.

A container's key changes over its life; each version is a generation `g`, starting at 1.
A pair only ever has generation 1. Each generation has a secret of 32 random bytes and a
commitment everybody who holds the secret can check:

    commitment_g = H(L("sealed-commitment") ‖ C ‖ u64(g) ‖ secret_g)

The service keeps each generation's commitment and shows it with every lock and header.

## 3. Locks

A lock hands a generation's secret to one member. It is 80 bytes, `enc ‖ ct`:

    enc, ct = SealAuth(pkR, info = L("sealed-lock") ‖ C ‖ u64(g),
                            aad  = recipient ‖ sender ‖ commitment_g,
                            pt   = secret_g, skS)

`recipient` and `sender` are peer ids. `pkR` is the recipient's registered encryption key
and `skS` the sender's.

- **In a pair,** the KEY that starts it makes the secret and locks it for both.
- **In a SPACE,** only a keeper locks: the owner, or a member the latest keeper list the
  owner signed names. And a keeper locks only for a member somebody the owner trusts
  vouched for (section 6): membership is the service's word, and an admin, a coordinator
  or the operator could grant it to anybody.

Opening one: `OpenAuth` with the sender's registered encryption key, which must come from
the sender's own checked statement, then the commitment must hold. The service cannot
make a lock, because it never holds a secret; it can only drop one, and a member it drops
finds it cannot read.

**Who a lock may come from, in a SPACE.** A member's software accepts a lock only from
the owner the service names, or from a keeper named in the latest keeper list, once it
has checked that the owner signed that list. A lock from any other KEY is refused, and
the member waits for a keeper: otherwise a service that registered a KEY of its own
could stage a generation whose secret it knows, lock it for every member, and read
whatever they seal next. One exception: the KEY that has just taken a SPACE over accepts
its own lock from the owner it took it over from, for the generation in use when it took
over and no later one, because it needs that secret to change the key (section 7). It
knows that owner from having seen the SPACE pass, or, when it first looks afterwards, from
the SPACE's governance log (`owner_was` in `space.handed_over`), whose fingerprint the
bridge then says beside the owner's.

**Who the owner is.** A SPACE passes only to a KEY the outgoing owner's latest keeper list
names as a keeper, and the service refuses any other hand-over
(`SEALED_SUCCESSOR_NOT_KEEPER`). A member's software remembers the owner it has seen, and
takes a new one only when a keeper list the owner before it signed named it: one the member
saw, or the latest list, which that owner signed. Otherwise it takes nothing from the new
owner and says so; a member that missed two hand-overs in a row is one of those, and trusts
again only once whoever runs it has compared the new owner's fingerprint outside the
service and removed what it remembered of the SPACE. It goes by keeper lists the owner in
place signed. The one the owner before signed, which is the latest when a SPACE passes,
counts as it was then until the member sees the owner in place sign one, and after that a
list anybody else signed is refused (`SEALED_LIST_FORGED`). It remembers the
latest keeper list's revision and bytes, and the generation in use, and refuses a service
that shows an older one of either. A member that meets a SPACE for the first time takes
the service's word, which is what comparing fingerprints outside the service is for. The
software that makes a SPACE remembers it as it made it, and never meets it for the first
time.

## 4. The chain

A SPACE's generations are chained, so whoever holds the newest secret can open every
earlier one: that is how a newcomer reads the history. For every `g ≥ 2` the service keeps
one back link, 48 bytes:

    back_g = AES(HKDF(empty, secret_g, L("sealed-chain") ‖ C ‖ u64(g), 16),
                 pt = secret_(g-1), aad = C ‖ u64(g-1))

Opening `back_g` with `secret_g` gives `secret_(g-1)`, and `commitment_(g-1)` must hold. A
reader walks back only as far as the item it is opening needs.

## 5. Items

A message or a post is sealed as a header and a ciphertext.

**The header** is canonical JSON, and everything in it is readable by the service:

    message: {"author","generation","pair","salt","suite","type":"message","v"}
             and, when present, "about", "reply_to"
    post:    {"author","generation","kind","salt","space_id","suite","type":"post","v"}
             and, when present, "reply_to", "retracts", "supersedes", "to"

| field | value |
|---|---|
| `v` | 1 |
| `suite` | 1 |
| `type` | `message` or `post` |
| `author` | the writer's peer id |
| `generation` | the generation it is sealed under |
| `salt` | 16 random bytes, as 32 lowercase hex characters |
| `pair` | a message's two peer ids, a JSON array of two hex strings, ascending |
| `space_id` | a post's SPACE |
| `kind` | a post's kind |
| `to` | a post's addressees: a JSON array of 1 to 8 hex peer ids, ascending, never the author |
| `reply_to` | a post id (post) or a message id (message) |
| `supersedes`, `retracts` | post ids, never both |
| `about` | the SPACE a message says it is about, by name, as the messages API names it |

A field that is absent is omitted, never null. The service refuses a header that does not
name what the request itself names: the container, the author (the KEY whose token sent
it), the current generation, and each routing field.

**The content** is canonical JSON too, sealed so only members read it:

    message: {"body"}
    post:    {"body"?, "budget"?, "data"?, "fingerprints"?, "run_id"?, "title"?}

Each field has the limit it has in a post that is not sealed: a body of 1 to 16,384 bytes
for a message and at most 65,536 for a post, a title of 1 to 512, fingerprints as SEEK
takes them (1 to 32 pairs, ascending by scheme then value, no repeats), data and budget as
the service validates them, and run_id a uuid. The service cannot check any of this; the
software that seals checks it before sealing, and the software that opens checks it again.

**Sealing:**

    hd = H(L("sealed-header") ‖ header)
    k  = HKDF(salt, secret_g, L("sealed-item") ‖ hd, 16)      salt: the header's 16 bytes, decoded
    ct = AES(k, content, aad = hd)

**Every sealing takes a fresh random salt, and a header is never used to seal two different
contents.** An item's key depends only on its header and the generation's secret, and the nonce
is zero, so sealing different content under one header would repeat a key and a nonce, which
loses AES-GCM's secrecy and its integrity both. Sending the same bytes again, which is what a
retry does, repeats nothing that matters: the same content under the same key gives the same
ciphertext.

**A signed sealed post.** A post's object (`src/domain/objects.ts`) carries, in place of
its title, body, fingerprints and private digest, which are all sealed:

    "sealed": {"ciphertext": hex(H(L("sealed-ciphertext") ‖ ct)), "header": hex(hd), "suite": 1}

so the author's signature covers the exact header and ciphertext stored. The service
writes the same object for an unsigned sealed post.

**Opening:** the header is canonical and names what the service shows; the secret for its
generation comes from the reader's own lock, or from the chain for an older one; the
commitment holds; `k` is derived and `ct` opened; the content is checked. Any failure means
the item could not be opened, and nothing of it is shown.

**In transport:** `{"header": b64u(header), "ciphertext": b64u(ct)}`. A header is at most
2,048 bytes; a message's ciphertext at most 64 KiB and a post's at most 180 KiB. Content
that JSON escaping makes larger than that cannot be sealed.

## 6. Keeper lists and stamps

**A keeper list** names who may lock a SPACE's secret and whom a keeper admits without
asking the owner. The owner signs it, and the service keeps every revision:

    list   = canonical({"admission","change_every","keepers","revision","space_id","stampers","v":1})
    signed = L("sealed-keepers") ‖ list

| field | value |
|---|---|
| `revision` | 1 for the first, then one more each time |
| `keepers` | the KEYS besides the owner that may lock: 0 to 32 peer ids, ascending |
| `admission` | `stamped`: a keeper admits by itself only a KEY with a stamp from a stamper; `open`: it admits every request |
| `stampers` | the KEYS whose stamp counts: 0 to 32 peer ids, ascending |
| `change_every` | seconds between key changes when someone has been removed: 60 to 604,800 |

The owner is always a keeper and never listed.

**A stamp** says a KEY belongs to its issuer, for a SPACE whose list names the issuer as a
stamper:

    stamp  = canonical({"issuer","not_after"?,"peer_id","v":1})
    signed = L("sealed-stamp") ‖ stamp

`not_after` is a time in whole seconds since 1970, after which the stamp no longer counts.
The KEY a stamp names puts it for a SPACE before it asks to join, and a keeper reads it
with the request; a newer one replaces it. A keeper that admits a KEY by hand stamps it
itself and puts the stamp for it, which only the issuer of a stamp, and only as a keeper,
may do for another KEY; and it never replaces another issuer's stamp that still vouches
for that KEY, which is kept. Both a list and a stamp are signed with the envelopes of section
1: the list by the owner, the stamp by its issuer.

**Vouched for.** A keeper hands a SPACE's key to a KEY only when somebody the owner trusts
vouched for it, by the latest keeper list:

- the owner, and every keeper the list names;
- every KEY, when the list's admission is `open`;
- otherwise a KEY whose stamp comes from the owner, a keeper or a stamper the list names,
  and has not run out.

With no list, the owner alone vouches, by its stamps. A list the owner before signed goes
on vouching, with its signer's stamps counting too, until the owner now in place signs one,
if it named that owner among its keepers: the members the SPACE was handed over with stay
vouched for. The service tells the owner a list of its own is needed (`upkeep.list_needed`)
until it signs one. A keeper's software checks each stamp's signature itself; the service's
`vouched` beside each member waiting is its own reading and is never trusted. A member
nobody vouched for is not handed the key, and a change of key never waits for one. A member
who holds the key when nobody vouches for it any more, because its stamp ran out or its
stamper was dropped, makes the next change due as a member who left does
(`upkeep.lapsed`).

## 7. Changing the key

When a member is removed, or a keeper leaves or hands over, a keeper makes generation
`g+1`:

1. A new random secret, its commitment and `back_(g+1)`.
2. A lock for every current member vouched for, uploaded in chunks, the keeper's own
   first, so a keeper that stops halfway can pick the change up again. Each chunk names
   the commitment its locks were made for, and is refused for any other: a change
   abandoned and staged again takes the same number.
3. It is activated. The service activates it only when every current member vouched for
   has a lock, and runs one change at a time.

A change nobody can finish, because the keeper that staged it lost the new secret, is
abandoned by a keeper (`DELETE /v1/spaces/{name}/sealed/generations/{g}`): its locks go
with it, nothing was ever sealed under it, and the next change stages its own. The bridge
abandons one it staged itself and holds no lock for, and one that has not moved, no lock
handed on for it, for fifteen minutes (`upkeep.staged_progressed_at`).

Items sealed under `g` are accepted until then and refused afterwards
(`KEY_CHANGED`); the writer seals again under `g+1`. Locks for older generations are then
deleted, since the chain reaches them. A KEY admitted while a change is staged gets a lock
for both generations.

When a member leaves or is removed, the change is due on the owner's schedule,
`change_every` after the key was last changed, or a day after it while the owner has signed
no list; the bridge and the website start a new list at a day too. Removing a member still
takes effect at once at the service, which shows the SPACE to it no more: the schedule is how
long a removed member that obtains new items some other way can still open them. A generation counts who has left from the
moment it was staged, not from when it was activated, since a member who leaves while a
change is under way may have opened its lock to the new key already; its locks for the
new key are deleted when it is activated, and the next change is due for it. When a keeper stops being one, because the
owner hands the SPACE over, a keeper leaves, or a new keeper list drops one, the change is
due at once: members' software accepts no lock from a KEY that keeps nothing now, so
until the key changes they wait. The service tells a keeper both
(`GET /v1/spaces/{name}/sealed`, `upkeep`).

**What a change costs, measured** on 19 September 2026 on one Mac against a local database
nothing else was using, with `scripts/sealed-change.ts`, which does what a keeper does
through the same routes:

| At 100,000 members | Handing the key to all | Changing the key |
|---|---|---|
| checking each member's encryption key | 12.5 s | 13.2 s |
| sealing a lock for each | 34.2 s | 34.0 s |
| the service storing them, a thousand a call | 6.4 s | 7.9 s |
| activating, and pruning the old locks | | 2.3 s |
| waiting out the keeper's write allowance | 21.0 s | 140.0 s |
| in all | 80.7 s | 206.5 s |
| change log written | 46 MB | 82 MB |

The locks of one generation take 58 MB with their indexes. A keeper that keeps running checks
each member's key once, so its later changes skip the first row. The wait is the per-KEY write
allowance, 60 calls and then one every two seconds, which a change of 101 calls meets; here the
change began with the allowance already spent on handing the key to all, the worst case. With
admission `stamped`, a keeper checks each member's stamp too, and the first row is 23.5 s, but
the totals stay 81.6 s and 206.1 s, since the checking takes time the allowance would have spent
waiting. The change log is what the backups keep for seven to fourteen days, so a SPACE this
size whose key changes once a day writes 82 MB of it a day; changed every hour, it would be
about 2 GB.

## 8. What the service can and cannot do

It can refuse, delay, drop, reorder or repeat items and locks, and it sees every header. It
cannot open an item, cannot make a lock, and cannot add a reader: a lock comes only from a
keeper's own software, and a keeper list only from the owner's. A keeper that admits any
KEY that asks admits the operator too if the operator asks, which is why `admission` is
the owner's choice and `stamped` is what keeps it out.

Who owns a SPACE is the service's word, as it is for any SPACE, and a member's software
holds that word to what it saw before (section 3). Every change of owner is in the
SPACE's governance log, which is chained and covered by the checkpoints the service
signs, so a member that keeps a checkpoint can tell if that word changes behind its back.

What is left to the service, and said here so nobody relies on it:

- **Words sent without sealing.** A client that sends a post's or a message's words to a
  sealed SPACE or pair, such as a connector with no bridge behind it, has sent them to the
  operator. The service refuses them and keeps nothing, but it received them. The bridge
  seals before anything leaves the machine, refuses to send plain words anywhere it has
  seen sealed, and refuses when asked to seal for something the service says is not.
  A file is the same: a sealed SPACE takes none, and bytes uploaded to one reach the
  service before it refuses them.
- **One secret for everybody.** The service shows every member the same commitment for a
  generation and the same keeper lists, and nothing but that says every member holds the
  same secret. A keeper that locked different secrets for different members, with a
  service that showed each member its own commitment, could have one sealed item read
  differently by different members, because AES-GCM does not bind a ciphertext to one key.
  Members who compare a generation's commitment, which the keepers' page shows, would see
  it. A version of the header that names the commitment would close it, and would be
  added beside this one.
- **Who sealed an unsigned item.** Unless the SPACE takes only signed posts, an unsigned
  sealed item's author is the service's word: every member holding a generation's secret
  can seal under a header that names another member, and only the service checks that a
  header's author is the KEY that sent it.
- **First contact.** A member's software takes the owner, the owner before it, the keeper
  list and the keys the service shows the first time it meets a SPACE or a KEY; the bridge
  then says the owner's fingerprint once, and that of the owner before when the service
  names one, in the answer that met the SPACE or in a keeper's log. Fingerprints compared
  outside the service are what check that.
- **Standing still.** What a member's software remembers stops the key going back, not
  standing still: a service that withholds a change of key from everybody keeps a removed
  member reading, until the members see the change.
- **A list withheld.** A member knows only the keeper lists it has seen. A keeper key that a
  newer list dropped, perhaps because it was stolen, can be made owner in the view of members
  the service never showed that list, and hand out keys of its own.
- **After a hand-over,** until the new owner signs a list, the owner before goes on vouching:
  a newcomer it stamps then is admitted and handed the key.
