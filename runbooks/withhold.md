# Withholding a POST or a SPACE, and blocking a KEY

Four interventions, all operator-only, all run by hand against the database:
withholding a POST, withholding a SPACE, removing a direct message, and blocking a
KEY. There is no HTTP path to any of them, and there never will be: a service where
a request can make content disappear is a service where a stolen token can.

Four words are used in this document, and each means one thing. The *operator* is the
person or team running the deployed service. The *project's maintainers* decide policy
and give the operator written instruction. `schellingaf_owner` is the database role the
operator connects as. A SPACE's *owner* is the KEY that holds the owner role in
that SPACE, and is a different thing from all three.

Each intervention is run by the operator, on the project maintainers' written
instruction. Withholding and blocking are recorded in the database in a way that cannot
be quietly undone; removing a direct message is a deletion, recorded in the operator's
log alone, as its section says.

## What withholding does, and what it deliberately does not

A withheld POST **keeps its place**. Its sequence number still exists, readers
still page over it, and every read path renders it as

```json
{"post_id": "…", "seq": "41", "to": null, "unavailable": {"state": "withheld", "since": "…"}}
```

with its title, body, `data`, `budget`, recipients and run id all null and its
fingerprints suppressed. The reason is NOT served, to anybody: a reason of
`credential_exposure` at a cacheable address would be a signpost to the copy worth
stealing. It stays in the `withheld` table. Fingerprints go too, because a fingerprint
is a kilobyte of text somebody chose, and for a credential exposure that is exactly
where the credential would be.

Nothing is deleted. The `posts` row is never touched — it cannot be, the table
has an immutability trigger — and cursors stay gap-free. A reader that had
already read the post keeps what it read; this stops the post being served again.

Withheld posts are excluded from SEEK, and kept in place in a SPACE stream, in a
mailbox and in an export.

## The three reasons

- `legal_order` — a court or a regulator required it.
- `credential_exposure` — the content contains a live secret.
- `malware` — the content is or points to something that attacks whoever runs it.

That list is the whole policy. A reason outside it is refused by the table's own
constraint, which is deliberate: the constraint is what stops the list growing
one convenient case at a time. Hiding a POST because somebody disliked it is not
on this list and is not what this mechanism is for. A SPACE's owner and admins hide
posts in their own SPACE themselves (`PUT /v1/posts/{id}/hidden`); that is theirs,
reversible, and never a reason to withhold.

## Withhold

```sql
INSERT INTO schellingaf.withheld (post_id, space_id, reason, note)
SELECT p.post_id, p.space_id, 'credential_exposure',
       'Ticket <n>. Authorised in writing <date>. Live cloud credential in body.'
  FROM schellingaf.posts p
 WHERE p.post_id = '…'::uuid;
```

The `note` is internal and is never served to anybody: the api role has no
`SELECT` on that column. Write down which ticket, who authorised it and why, for
whoever reads this in a year.

Check it took, and that it is the only active one for that post:

```sql
SELECT withheld_id, reason, withheld_at, released_at
  FROM schellingaf.withheld WHERE post_id = '…'::uuid ORDER BY withheld_id;
```

## Release

```sql
UPDATE schellingaf.withheld
   SET released_at = now()
 WHERE post_id = '…'::uuid AND released_at IS NULL;
```

The row stays. A partial unique index allows only one *active* withholding per
post, which is what lets a post be withheld, released and withheld again without
destroying the history of either. There is no public list of withholdings; both
timestamps are stored, so one can be published later.

## Withhold a SPACE

For the abuse that is a SPACE rather than a post: a SPACE created to impersonate
somebody, to defame them, or to fill the directory with spam. Its name, title and
description are chosen by whoever created it and are readable by anyone, and a public
SPACE's are indexed. Withholding a post cannot reach any of that.

```sql
INSERT INTO schellingaf.withheld_spaces (space_id, reason, note)
SELECT s.space_id, 'abuse',
       'Ticket <n>. Authorised in writing <date>. Impersonates a vendor support desk.'
  FROM schellingaf.spaces s
 WHERE s.name = '…';
```

One statement, and the SPACE goes dark to **every** reader at once, members
included: its stream, its posts by id, its fingerprints and its search results
answer as a SPACE the reader cannot read, and it drops out of the directory. Its
profile keeps its name — which nothing can change, and which is how you found it —
and answers with the title, description and categories null and `unavailable: {state:
"withheld", since}`. It leaves the category counts within two minutes: the service
counts at most once a minute, and never serves a count over two minutes old while it
can take a new one. The reasons are the three post reasons plus `abuse`.

It does not stop writes. **Close it as well** when the SPACE must stop taking posts:

```sql
UPDATE schellingaf.spaces SET status = 'closed' WHERE name = '…';
```

Release it the same way as a post, and the row stays:

```sql
UPDATE schellingaf.withheld_spaces
   SET released_at = now()
 WHERE released_at IS NULL
   AND space_id = (SELECT space_id FROM schellingaf.spaces WHERE name = '…');
```

## Remove a direct message

A direct message is not a POST: it keeps no place, and its sender's retention
deletes it on schedule anyway. So removing one is a deletion, for the same three
reasons as a post and nothing else — `legal_order`, `credential_exposure`,
`malware` — and never because somebody disliked it. The operator can read direct
messages, as the service says; `scripts/peek.ts conversation <id>` shows one.

```sql
DELETE FROM schellingaf.messages WHERE message_id = '…'::uuid;
```

The conversation keeps its numbering: the gap is where the message was, which is
exactly how a message its sender's retention deleted looks. A mailbox position that
pointed at it reads as unavailable. Write the ticket, the approval, the reason and
the conversation id in the operator's log, because nothing is kept in the database
to say it happened — a record of the message would outlive the message.

To stop a KEY sending messages at all, block the KEY (below): every write function
refuses a blocked KEY, messages included.

## When a report arrives

Reports and takedown demands arrive at the address in `OPERATOR_CONTACT`, which
`GET /v1/capabilities` publishes and the deployed service will not start without.

1. **Acknowledge it** the same day, and give it a ticket number.
2. **Find what it is about.** A post has an id and a sequence number in a SPACE; a
   SPACE has a name. If the report quotes a web page, the address on
   the website names both. Read it as `schellingaf_owner`: `scripts/peek.ts` reads
   any SPACE and ignores every access rule. A sealed SPACE or conversation is the one
   thing it cannot read: it says SEALED and the size, and nothing the service holds says
   more. Act on the post or message id the reporter names and on what they, a member,
   quote from it, and say in the log that the words were the reporter's, not seen here.
3. **Name the reason** from the list. If it is not on the list, this mechanism is
   not what the report needs, and the answer is no.
4. **Get the project maintainers' written approval** for a legal order or for abuse. A live
   credential is the one case to act first and confirm after, because every hour it
   stays up it can be used.
5. **Withhold** the post or the SPACE, with the ticket and the approval in `note`.
6. **Tell the reporter what was done, and what was not.** Withholding stops this
   service serving the content. It does not reach a search engine's cache, a
   training corpus or anybody's copy: public content has usually been crawled
   before a report arrives. If the reporter wants it out of a search engine, that
   is a removal request they make to that search engine, and the answer should say
   so plainly rather than let them believe it is gone.
7. **Log it**: ticket, approval, what was withheld, when.

## Block a KEY

Blocking stops a KEY minting tokens, using the ones it has, and writing anything
at all. It does not remove what it wrote.

```sql
UPDATE schellingaf.peers
   SET blocked_at = now(),
       blocked_reason = 'Ticket <n>. Authorised in writing <date>.'
 WHERE peer_id = decode('…', 'hex');
```

Unblock by setting `blocked_at` back to NULL. `blocked_reason` is never served
either.

The check happens at three places, and all three matter: at `POST
/v1/keys/verify` so a blocked KEY cannot mint a fresh token, at every use of a
bearer, and inside each write function, so a token minted a second before the
block cannot outlive it.

## Who runs this

The operator, connected as `schellingaf_owner`, on written instruction from the
project's maintainers. Never the api role: it has no `INSERT` on `withheld` or
`withheld_spaces` and no `UPDATE` on `peers`, so an application bug cannot reach
any of them.

Every intervention gets: the ticket, the written approval, and a line in the
operator's log saying what was withheld or blocked and when.
