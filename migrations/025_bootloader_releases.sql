-- Decouple uploaded bootloader versions from the active release pointer, relax version
-- formatting to semver or git commit hashes, and store every uploaded file's size and
-- staging upload ID in structured columns.

CREATE TABLE esphub.bootloader_releases (
  id text PRIMARY KEY,
  version text NOT NULL,
  promoted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (id, version) REFERENCES esphub.bootloaders (id, version)
);

-- Backfill each existing bootloader ID to its highest semver version before relaxing
-- the version constraint.
INSERT INTO esphub.bootloader_releases (id, version)
SELECT DISTINCT ON (id) id, version
FROM esphub.bootloaders
ORDER BY id, string_to_array(version, '.')::int[] DESC
ON CONFLICT (id) DO NOTHING;

ALTER TABLE esphub.bootloaders
  DROP CONSTRAINT bootloaders_version_check,
  ADD CONSTRAINT bootloaders_version_check
    CHECK (version ~ '^([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?|[0-9a-f]{7,40})$'),
  ADD COLUMN bootloader_size integer CHECK (bootloader_size > 0),
  ADD COLUMN bootloader_upload_id uuid,
  ADD COLUMN partition_table_size integer CHECK (partition_table_size > 0),
  ADD COLUMN partition_table_upload_id uuid,
  ADD COLUMN launcher_upload_id uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'esphub_runtime') THEN
    GRANT SELECT, INSERT ON esphub.bootloaders TO esphub_runtime;
    GRANT SELECT, INSERT, UPDATE ON esphub.bootloader_releases TO esphub_runtime;
  END IF;
END $$;
