-- A first install flashes the board's shared bootloader set, its app and the device's
-- private NVS image. The firmware publisher records each bootloader set once, for every
-- board that uses it, instead of per-board bootloader releases and setup kits.
ALTER TABLE esphub.boards ADD COLUMN bootloader text CHECK (bootloader ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
CREATE TABLE esphub.bootloaders (
  id text NOT NULL CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  chip text NOT NULL,
  flash_mode text NOT NULL, flash_size text NOT NULL, flash_freq text NOT NULL,
  bootloader_offset integer NOT NULL, bootloader_key text NOT NULL, bootloader_sha256 text NOT NULL,
  partition_table_offset integer NOT NULL, partition_table_key text NOT NULL, partition_table_sha256 text NOT NULL,
  launcher_offset integer NOT NULL, launcher_key text NOT NULL, launcher_sha256 text NOT NULL, launcher_size integer NOT NULL,
  app_offset integer NOT NULL, nvs_offset integer NOT NULL, nvs_size integer NOT NULL,
  PRIMARY KEY (id, version)
);

-- Per-board releases are app-only. Remove the per-board bootloader and setup releases and
-- every file they published. The previous publisher may still write them until it is
-- replaced, so kind keeps no constraint and the Hub reads only app releases.
DELETE FROM esphub.release_assets WHERE asset IN ('ota', 'usb', 'manifest', 'setup', 'setup-manifest');
DELETE FROM esphub.firmware_releases WHERE kind IN ('bootloader', 'setup');

-- Appending keeps the existing grants on the view.
CREATE OR REPLACE VIEW esphub.board_profiles AS
  SELECT b.id, b.source_revision, b.name, b.model, b.chip, b.flash_mb,
    b.preview, b.display_order, b.default_example, s.sdk_version, s.is_current,
    b.published_examples, b.bootloader_source_url, s.sdk_source_url, b.bootloader
  FROM esphub.boards b JOIN esphub.board_sources s ON s.revision = b.source_revision;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'esphub_runtime') THEN
    GRANT SELECT ON esphub.board_profiles, esphub.bootloaders TO esphub_runtime;
  END IF;
END $$;

-- Extend the existing, explicitly granted release-publisher privileges to bootloader sets.
DO $$
DECLARE publisher name;
BEGIN
  FOR publisher IN
    SELECT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'esphub' AND table_name = 'firmware_releases'
      AND privilege_type IN ('INSERT', 'UPDATE') AND grantee NOT IN ('PUBLIC', current_user)
    GROUP BY grantee HAVING count(DISTINCT privilege_type) = 2
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON esphub.bootloaders TO %I', publisher);
  END LOOP;
END $$;
