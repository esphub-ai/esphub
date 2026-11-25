-- Accept version-only publications while the previous release writer is still live.
ALTER TABLE esphub.firmware_releases DROP CONSTRAINT firmware_releases_check;

CREATE TABLE esphub.board_sources (
  revision text PRIMARY KEY CHECK (revision ~ '^[0-9a-f]{40}$'),
  sdk_version text NOT NULL,
  upstream_repository text NOT NULL,
  upstream_ref text NOT NULL,
  is_current boolean NOT NULL
);
CREATE UNIQUE INDEX board_sources_one_current ON esphub.board_sources (is_current) WHERE is_current;

CREATE TABLE esphub.boards (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$'),
  source_revision text NOT NULL REFERENCES esphub.board_sources(revision),
  name text NOT NULL,
  model text NOT NULL,
  chip text NOT NULL,
  flash_mb integer NOT NULL CHECK (flash_mb >= 8),
  bootloader text NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('micropython', 'native')),
  preview boolean NOT NULL,
  has_setup boolean NOT NULL,
  hello text,
  display_order integer
);

CREATE VIEW esphub.board_profiles AS
  SELECT b.*, s.sdk_version, s.upstream_repository, s.upstream_ref, s.is_current
  FROM esphub.boards b JOIN esphub.board_sources s ON s.revision = b.source_revision;

-- Extend the existing, explicitly granted release-publisher privileges to its board metadata.
DO $$
DECLARE publisher name;
BEGIN
  FOR publisher IN
    SELECT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'esphub' AND table_name = 'firmware_releases'
      AND privilege_type IN ('INSERT', 'UPDATE') AND grantee NOT IN ('PUBLIC', current_user)
    GROUP BY grantee HAVING count(DISTINCT privilege_type) = 2
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON esphub.boards, esphub.board_sources TO %I', publisher);
    EXECUTE format('GRANT DELETE ON esphub.board_sources TO %I', publisher);
  END LOOP;
END $$;
