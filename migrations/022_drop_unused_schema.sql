-- Clerk replaced the original passkey sign-in. Nothing reads these tables, and
-- the runtime role has no access to them.
DROP TABLE esphub.access_tokens;
DROP TABLE esphub.challenges;
DROP TABLE esphub.credentials;

-- Virtual boots are ordered by sequence. Nothing reads or writes their start time.
ALTER TABLE esphub.virtual_boots DROP COLUMN started_at;
