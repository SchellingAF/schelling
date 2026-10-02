-- migrate: no-transaction
--
-- The indexes the SPACE list's counts=true and prefix= read (0123_space_stages.sql),
-- built concurrently, so posts and the SPACES go on being written while they build.
-- One statement at a time (src/db/migrate.ts). A build that failed leaves its index
-- invalid, and a run that stopped part way leaves the file unrecorded, so each index is
-- dropped, if it is there, and built again: the file runs again from the start.

-- The migrate role waits 10 s for a lock, and a concurrent build waits for every
-- transaction older than itself, so one slow transaction would cancel the build. This
-- file waits up to ten minutes instead, and sets the role's wait back at the end.
SET lock_timeout = '10min';

-- The first post of a SPACE's window: one probe, index only. seq is in the key, the
-- window's tie-break, so no sort reads a second post to find the first.
DROP INDEX CONCURRENTLY IF EXISTS schellingaf.posts_space_posted_idx;
CREATE INDEX CONCURRENTLY posts_space_posted_idx ON schellingaf.posts (space_id, posted_at, seq) INCLUDE (post_id);

-- The window's hidden and withheld posts: a range from its first post, never every one
-- the SPACE ever had.
DROP INDEX CONCURRENTLY IF EXISTS schellingaf.space_hidden_space_post_idx;
CREATE INDEX CONCURRENTLY space_hidden_space_post_idx ON schellingaf.space_hidden (space_id, post_id);
DROP INDEX CONCURRENTLY IF EXISTS schellingaf.withheld_space_post_idx;
CREATE INDEX CONCURRENTLY withheld_space_post_idx ON schellingaf.withheld (space_id, post_id) WHERE released_at IS NULL;

-- prefix=: the names that start with it, in byte order whatever the database's
-- collation, as src/http/spaces.ts compares them. The list's order and its cursors keep
-- the default collation and its own indexes.
DROP INDEX CONCURRENTLY IF EXISTS schellingaf.spaces_name_c_idx;
CREATE INDEX CONCURRENTLY spaces_name_c_idx ON schellingaf.spaces (name COLLATE "C");
DROP INDEX CONCURRENTLY IF EXISTS schellingaf.space_categories_name_c_idx;
CREATE INDEX CONCURRENTLY space_categories_name_c_idx ON schellingaf.space_categories (category, name COLLATE "C");

RESET lock_timeout;
