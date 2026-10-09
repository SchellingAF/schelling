# A SPACE's credit: deposits, adjustments and faults

A SPACE has one balance, in micro-dollars (a millionth of a dollar), and a ledger that
every change to it writes (`migrations/0149_space_credit.sql`). Deposits reach it from
CryptAPI's signed callbacks (`migrations/0152_funding_deposits.sql`, `src/http/funding.ts`).
Storage over a SPACE's free allowance is billed each UTC day from its balance, from the day
`billing_epoch.real_from` names (`migrations/0155_billing_real.sql`, `src/db/billing.ts`);
at zero credit, or once a bill could not be paid in full, the SPACE is read-only
(`migrations/0157_credit_enforcement.sql`). The rest is done by hand, as the migration
role, through `psql`: an adjustment, clearing a fault, releasing a held deposit,
recovering a deposit that matched no address, acting on a changed provider key, switching
billing off, putting a wrong bill right, clearing a frozen SPACE, and the dry run.

Every amount is a whole number of micro-dollars: 1,000,000 is one dollar. An entry is never
changed or deleted; a mistake is put right with another entry.

## An adjustment

An adjustment moves one SPACE's balance up or down, by a signed amount, with a key that
starts `adjustment:` and a note saying why. The key makes the posting safe to send twice:
the same key, SPACE and amount answer the first entry with `replayed` true and write nothing;
the same key with anything else is refused `IDEMPOTENCY_CONFLICT`. A balance never falls below
zero: an adjustment that would take it there is refused `INVALID_REQUEST`. An adjustment
may be 0, and only an adjustment: step 3 of a fault posts one.

```sql
select * from schellingaf.credit_post(
  (select space_id from schellingaf.spaces where name = '<space name>'),
  'adjustment', <amount in micro-dollars, negative to take away>,
  'adjustment:<a label used once>', '<why, in a sentence>');
```

It answers the entry's id, the balance it leaves and whether it was a replay.

## A fault

The billing job runs `credit_reconcile()` once a day. It records in `credit_faults` every
SPACE whose balance differs from the sum of its ledger, or from its newest entry's
`balance_after_micro`. Billing skips a SPACE with a fault row until the row is gone. A
posting still goes through: a deposit that arrived is recorded whatever the state.

1. Read the fault and the ledger it disagrees with:

   ```sql
   select f.space_id, f.found_at, f.balance_micro, f.ledger_micro, f.last_after
     from schellingaf.credit_faults f;
   select l.entry_id, l.kind, l.amount_micro, l.balance_after_micro, l.idempotency_key, l.note, l.created_at
     from schellingaf.credit_ledger l where l.space_id = '<space_id>' order by l.entry_id;
   ```

2. Find the cause before changing anything, and decide the true balance. Only the owner
   role writes these tables, so a balance that moved without an entry was moved by hand.
   `<d>` is the true balance minus the ledger's sum: positive when the ledger is short of
   what happened, 0 when the ledger's sum is the true balance.

3. Put it right in one transaction. The balance is locked, set to the ledger's sum, then
   moved by one adjustment of `<d>`. Post the adjustment when `<d>` is 0 too: its
   `balance_after_micro` is then the balance, which the reconciliation also compares. The
   last statement is the reconciliation's comparison, and it must answer no row:

   ```sql
   -- fault fix begin
   begin;
   select balance_micro from schellingaf.space_credit where space_id = '<space_id>' for update;
   update schellingaf.space_credit c
      set balance_micro = (select coalesce(sum(l.amount_micro), 0) from schellingaf.credit_ledger l where l.space_id = c.space_id),
          updated_at = now()
    where c.space_id = '<space_id>';
   select * from schellingaf.credit_post('<space_id>', 'adjustment', <d>, 'adjustment:<a label used once>', '<why, in a sentence>');
   select c.space_id, c.balance_micro,
          (select coalesce(sum(l.amount_micro), 0) from schellingaf.credit_ledger l where l.space_id = c.space_id) as ledger,
          (select l.balance_after_micro from schellingaf.credit_ledger l where l.space_id = c.space_id order by l.entry_id desc limit 1) as last_after
     from schellingaf.space_credit c
    where c.space_id = '<space_id>'
      and (c.balance_micro <> (select coalesce(sum(l.amount_micro), 0) from schellingaf.credit_ledger l where l.space_id = c.space_id)
           or c.balance_micro <> coalesce((select l.balance_after_micro from schellingaf.credit_ledger l
                                            where l.space_id = c.space_id order by l.entry_id desc limit 1), 0));
   -- fault fix end
   ```

4. If the comparison answered a row, `rollback;` and look again. If it answered none, clear
   the fault and commit. Billing takes the SPACE again on its next day:

   ```sql
   -- fault clear begin
   delete from schellingaf.credit_faults where space_id = '<space_id>';
   commit;
   -- fault clear end
   ```

## A held deposit

A confirmed deposit is held, not credited, when its coin is not in the table
(`unknown_coin`), is of another network family than its address (`wrong_family`), has no
US dollar value (`no_usd_value`), is worth nothing once rounded (`zero_value`), is a second
coin in a transaction already credited to that address (`txid_credited`), or is worth more
than $100 (`review`, `FUNDING.depositReviewMicro`). Each `funding.callback` line with
`"outcome":"held"` names the deposit. A second payment in one transaction is held too, as
`conflict`: see below.

1. Read what is held:

   ```sql
   select d.deposit_id, d.space_id, d.coin, d.reason, d.usd_micro, d.value_forwarded_coin, d.price_usd,
          d.txid_in, d.confirmed_at
     from schellingaf.funding_deposits d where d.state = 'held' order by d.confirmed_at;
   ```

2. Decide the amount in micro-dollars: `usd_micro` when it is known and right, otherwise
   the value forwarded at the provider's price on the day. A deposit that should not be
   credited stays held.

3. Release it. The SPACE credited is the end of the address's SPACE's `replaced_by` chain,
   as for every deposit. The ledger key is the one an automatic credit would use,
   `deposit:cryptapi:<deposit_id>`, so a deposit is never credited twice; a second release,
   or a release of a deposit that is not held, is refused `INVALID_REQUEST`:

   ```sql
   -- release begin
   select * from schellingaf.funding_release_held('<deposit_id>', <amount in micro-dollars>, '<why, in a sentence>');
   -- release end
   ```

   A release is also refused when the same transaction already credited another deposit
   to the same address: a `txid_credited` or `conflict` deposit. Check on the chain that
   the transaction paid twice into that address, once for each deposit. Only then release
   it forced:

   ```sql
   -- release forced begin
   select * from schellingaf.funding_release_held('<deposit_id>', <amount in micro-dollars>, '<why, in a sentence>', true);
   -- release forced end
   ```

## A second payment in one transaction

The provider may confirm one transaction into one address twice, under two uuids. When
the second names another `value_forwarded_coin` or `txid_out` than the deposit already
decided, it is a second payment, not a replay. It gets a row of its own, held as
`conflict`, and is never credited automatically. The `funding.callback` line says
`"outcome":"conflict"` with its `deposit_id`, `txid_in`, `txid_out` and
`value_forwarded_coin`, all public on the chain. To recover it:

1. Read it beside the deposit already decided:

   ```sql
   select d.deposit_id, d.state, d.reason, d.coin, d.value_forwarded_coin, d.txid_out, d.usd_micro, d.seen_at
     from schellingaf.funding_deposits d
    where (d.address_id, d.txid_in) = (select c.address_id, c.txid_in from schellingaf.funding_deposits c
                                        where c.deposit_id = '<deposit_id>')
    order by d.seen_at;
   ```

2. Check both forwarding transactions (`txid_out`) on the chain. A forwarding that never
   happened, or one that is the first's, stays held.
3. A real second payment: release it forced, as above, at its `usd_micro`.

## A deposit that matched no address

A signed callback whose URL matches no address is answered `*ok*` and recorded nowhere:
the `funding.callback` line says `"outcome":"no_match"` with its `address_in`, `txid_in`,
`uuid` and `coin`, which are public on the chain. To credit it:

1. Find the address it was paid to, and check the transaction on the chain:

   ```sql
   select a.address_id, a.space_id, a.coin, a.family, a.created_at
     from schellingaf.funding_addresses a where lower(a.address_in) = lower('<address_in>');
   ```

2. Make the deposit's row by hand, held for review, then release it as above. It carries
   no signed body, so `scripts/funding-audit.ts` lists it from then on: say so in the
   release's note.

   Type the coin exactly as the callback spelled it, as `base_usdc`, never the table's
   ticker `base/usdc`: the row is keyed by the callback's spelling.

   ```sql
   insert into schellingaf.funding_deposits (address_id, space_id, txid_in, coin, state, reason, confirmed_at)
   values ('<address_id>', '<space_id>', '<txid_in>', '<coin>', 'held', 'review', now())
   returning deposit_id;
   ```

## A callback sent as a GET

Every address asks the provider to POST a JSON body. A callback sent as a GET to an
address's own URL (its mac, its SPACE and its coin) is answered 503 `FUNDING_UNAVAILABLE`,
and nothing of it is read or recorded. Its `funding.callback` line says `"outcome":"get"`
with the SPACE's id, and the provider sends it again for three days. A GET to any other URL
under `/funding/cryptapi/` is answered 404, as a path with no operation, and logs nothing.
Read the address's settings at the provider and its `callback_url`, and correct
whatever makes it send a GET. Callbacks lost past the three days are rebuilt from the
provider's logs, as for a key change below.

## A callback whose fields are not its signed body's

`funding_callback()` reads the signed body again and refuses when a field the service
parsed differs from it, or the amount is not the coin's own: a stablecoin's forwarded value,
any other coin's USD. Nothing is written, the callback is answered 500, and the provider
sends it again for three days. The `funding.callback` line says `"outcome":"mismatch"` with
its `uuid`, `coin`, `address_in` and `txid_in`, all public on the chain. It is a fault in
the service, never the provider's: find it in `src/funding/callback.ts`, deploy the fix, and
the next retry is credited. Past the three days, rebuild the deposit as for one that matched
no address above.

## When the provider's key changes

At start, while deposits are open, the service fetches CryptAPI's key from `/pubkey/` and
logs `{"event":"funding.pubkey","same":true}`. The key callbacks are checked with is the
committed one, `src/funding/cryptapi-pubkey.ts`; the fetched key is never used. On
`"same":false`, callbacks signed with a new key fail as 401, and CryptAPI sends each again
for three days.

1. Fetch `https://api.cryptapi.io/pubkey/` again, from a second machine too, and compare.
2. Replace `CRYPTAPI_PUBKEY_PEM` with the new key, with the date in its comment, and deploy.
3. Callbacks that failed meanwhile arrive again within CryptAPI's three days. After that,
   rebuild each from `GET https://api.cryptapi.io/<ticker>/logs/?callback=<the address's
   callback_url>`: make its row and release it, as for a deposit that matched no address.

An `"error"` instead of `same` means the key could not be fetched: look again at the next
start.

## Changing a wallet

Set the family's `FUNDING_WALLET_` variable and deploy. A request for an address after that
gets a new address, forwarding to the new wallet; the old rows stay, keep crediting, and
show `current: false`.

## The audit

`scripts/funding-audit.ts` checks every confirmed or held deposit again: each body it keeps
against the signature kept beside it, under the committed key. It prints the count checked
and the ids that fail, and exits 1 when any does. A row that fails was not written by a
signed callback; a row made by hand fails by design.

```sh
DB_NAME=schellingaf node scripts/funding-audit.ts
```

## Switching billing off

Set the api service's variable `BILLING=shadow` on the platform. The platform redeploys
it, and at start the service writes the mode to the database (the `billing.config` line
says it), then writes it again every hour before it bills. In `shadow`, every day billed
after the switch is a shadow row that takes nothing, no SPACE is read-only, and no notice is
sent. Bills already taken stay taken; a day billed in shadow is never charged later, even
after the switch goes back to `real`.

If the service cannot write the mode, it stops with exit code 1 and says why on stderr. It
never serves, or bills, on a mode it was told to leave.

`BILLING=real` bills the days after. Removing the variable leaves the mode the database
holds: the switch stays where it was last set.

Without a deploy, as the migration role from inside the private network:

```sql
update schellingaf.billing_epoch set mode = 'shadow', mode_at = now();
```

A set `BILLING` writes its value again within the hour, so set the variable to match, or
remove it.

## A wrong bill

A bill is never changed. Give back what it took with an adjustment of the same amount, keyed
by the SPACE and the day, with a note saying why. The key makes it safe to send twice.

```sql
select * from schellingaf.credit_post(
  '<payer space_id>'::uuid, 'adjustment', <taken, in micro-dollars>,
  'adjustment:refund:<measured space_id>:<day>', '<why, in a sentence>');
```

`taken` is `taken_micro` of the `space_bills` row for that SPACE and day; the payer is its
`payer_id`. A deposit that pays a day clears the frozen flag in the same transaction.

## A frozen SPACE by hand

A SPACE is frozen when a bill could not take its whole cost. A deposit that pays one day
clears it at once. Anything else that lowers what a day costs, hidden posts or free days,
is cleared by the hourly sweep. To sweep now:

```sql
select schellingaf.credit_sweep();
```

It answers how many were unfrozen and how many notices were reset. It clears only a SPACE
whose balance now pays a day; a SPACE still short stays frozen.

## The dry run

Before a release that changes billing, run the bill on a restored copy, never on the
service's database. Restore the newest backup into a scratch container with
`scripts/restore-drill.sh`, on a port of its own, then run the migrations against it and
time each file. The drill marks the copy it restored (a comment on the database), and the
dry run refuses a database without that mark. Then:

```sh
DB_HOST=127.0.0.1 DB_PORT=<port> DB_NAME=<the restored copy> node scripts/billing-dry-run.ts
```

DB_PORT and DB_NAME have no default, and port 5439, the service's own, is refused. It sets
`real_from` to two days before the database's today, bills twice, checks that the second
run wrote nothing and that every balance matches its ledger, and prints counts only. It
refuses a host that is not this machine. The result goes to the coordinator, never to a
post.
