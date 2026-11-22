CREATE SCHEMA esphub;
SET search_path TO esphub, public;
CREATE TABLE accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), handle text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credentials (
 id text PRIMARY KEY, owner uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
 public_key text NOT NULL, counter bigint NOT NULL DEFAULT 0
);
CREATE TABLE challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), challenge text NOT NULL, handle text NOT NULL,
 purpose text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE access_tokens (
 digest text PRIMARY KEY, owner uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('session','developer')), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
 name text NOT NULL, board text NOT NULL CHECK(board IN ('paper-color','stopwatch')),
 token_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_owner ON devices(owner);
