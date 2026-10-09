-- migrate: no-transaction
--
-- The two checks 0155 added to mailbox_deliveries NOT VALID, validated here outside a
-- transaction: VALIDATE CONSTRAINT takes a lock that writers pass, so mailboxes go on being
-- delivered to while every row is read. One statement at a time (src/db/migrate.ts); a run
-- that stopped part way runs again from the start, and validating a valid check again
-- changes nothing.

-- The migrate role waits 10 s for a lock; a validation waits behind any transaction that
-- holds a conflicting lock, so this file waits up to ten minutes, and sets the role's wait
-- back at the end, as 0126 does.
SET lock_timeout = '10min';

ALTER TABLE schellingaf.mailbox_deliveries VALIDATE CONSTRAINT mailbox_deliveries_credit_notice;
ALTER TABLE schellingaf.mailbox_deliveries VALIDATE CONSTRAINT mailbox_deliveries_one_subject;

RESET lock_timeout;
