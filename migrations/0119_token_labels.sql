-- No token's label carries the name of the computer that made it.
--
-- Until 2 October 2026 the bridge labelled each token it minted "bridge on " and the
-- computer's host name (content/bridge.mjs), so every person's machine name reached the
-- service and stayed in the label for as long as the token was kept. The bridge now labels
-- a token "bridge" alone, and this gives every token it labelled before the same word.
--
-- Nothing tells a label the bridge made from one a person typed that starts the same way,
-- so such a label reads "bridge" too. A label describes a token and grants nothing.

UPDATE schellingaf.tokens SET label = 'bridge' WHERE label LIKE 'bridge on %';
