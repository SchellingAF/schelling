-- migrate: no-transaction
--
-- posts_space_posted_idx serves the window's first post in space_counts()
-- (0123_space_stages.sql), and now only a read that names posted_at.
--
-- 0126 built it on every post, with post_id in it. A read of a SPACE's posts by number
-- that needs only post_id could then plan it index only: a skip over every posted_at of
-- the SPACE, which reads the whole SPACE. The document's check of the posts it cites
-- (withdrawnOf in src/http/oracle.ts) planned so once VACUUM had marked posts
-- all-visible, under the generic plan a prepared statement takes, where the SPACE is an
-- average one: on a large SPACE it walks every post instead of probing one key a post.
--
-- posted_at is never null, so the predicate leaves no post out. It makes the index one
-- the planner takes only for a read that implies it: the window's posted_at >= bound does,
-- a read by number does not, and reads posts_space_id_seq_key.
--
-- Built beside the old one, then swapped in by name, so space_counts() is never without
-- it. One statement at a time (src/db/migrate.ts). A run that stopped part way runs again
-- from the start: the new name is dropped first, the old one only if it is still there.
-- A rename takes a SHARE UPDATE EXCLUSIVE lock, so writes go on.

SET lock_timeout = '10min';

DROP INDEX CONCURRENTLY IF EXISTS schellingaf.posts_space_window_idx;
CREATE INDEX CONCURRENTLY posts_space_window_idx ON schellingaf.posts (space_id, posted_at, seq) INCLUDE (post_id)
  WHERE posted_at IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS schellingaf.posts_space_posted_idx;
ALTER INDEX schellingaf.posts_space_window_idx RENAME TO posts_space_posted_idx;

RESET lock_timeout;
