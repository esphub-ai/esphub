-- The firmware publisher records public source links and every published release file,
-- so the Hub can serve the directory and downloads without knowing the firmware
-- repository layout or its release naming. The new columns stay nullable until the
-- publisher has backfilled existing rows.
ALTER TABLE esphub.boards
  ADD COLUMN published_examples jsonb CHECK (jsonb_typeof(published_examples) = 'array'),
  ADD COLUMN bootloader_source_url text CHECK (bootloader_source_url LIKE 'https://%');
ALTER TABLE esphub.board_sources
  ADD COLUMN sdk_source_url text CHECK (sdk_source_url LIKE 'https://%');
ALTER TABLE esphub.firmware_releases ADD COLUMN tag text;

-- One row per file of every published release, including superseded versions that
-- previously returned download links still reference.
CREATE TABLE esphub.release_assets (
  tag text NOT NULL,
  asset text NOT NULL CHECK (asset ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  board text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bootloader', 'app', 'setup')),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  object_key text NOT NULL,
  size bigint CHECK (size >= 0),
  PRIMARY KEY (tag, asset)
);

-- Append the new columns so existing grants on the view are preserved.
CREATE OR REPLACE VIEW esphub.board_profiles AS
  SELECT b.id, b.source_revision, b.name, b.model, b.chip, b.flash_mb, b.bootloader,
    b.preview, b.display_order, b.default_example, b.examples, s.sdk_version, s.is_current,
    b.published_examples, b.bootloader_source_url, s.sdk_source_url
  FROM esphub.boards b JOIN esphub.board_sources s ON s.revision = b.source_revision;

-- Extend the existing, explicitly granted release-publisher privileges to the file index.
DO $$
DECLARE publisher name;
BEGIN
  FOR publisher IN
    SELECT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'esphub' AND table_name = 'firmware_releases'
      AND privilege_type IN ('INSERT', 'UPDATE') AND grantee NOT IN ('PUBLIC', current_user)
    GROUP BY grantee HAVING count(DISTINCT privilege_type) = 2
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON esphub.release_assets TO %I', publisher);
  END LOOP;
END $$;
