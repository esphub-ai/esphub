-- Clerk replaced the original passkey sign-in. Nothing reads these tables, and
-- the runtime role has no access to them.
DROP TABLE esphub.access_tokens;
DROP TABLE esphub.challenges;
DROP TABLE esphub.credentials;
