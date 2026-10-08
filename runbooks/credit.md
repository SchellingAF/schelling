# A SPACE's credit: adjustments and faults

A SPACE has one balance, in micro-dollars (a millionth of a dollar), and a ledger that
every change to it writes (`migrations/0149_space_credit.sql`). In this release nothing is
deposited and nothing is billed: billing is measured in shadow (`src/db/billing.ts`), and no
route or role but the owner posts an entry. Two things are done by hand, as the migration
role, through `psql`: an adjustment, and clearing a fault.

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
