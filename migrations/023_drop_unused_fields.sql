-- Columns that no code reads. Clerk subjects identify accounts, and the handle was a
-- placeholder left from passkey sign-in. Virtual boots never recorded messages.
ALTER TABLE esphub.accounts DROP COLUMN handle, DROP COLUMN created_at;
ALTER TABLE esphub.device_commands DROP COLUMN created_at;
ALTER TABLE esphub.virtual_boots DROP COLUMN messages;

-- The Hub serves published examples and source links, so the firmware publisher no longer
-- writes the raw examples, the bootloader variant or the release kind and version per file.
DROP VIEW esphub.board_profiles;
ALTER TABLE esphub.boards DROP COLUMN examples, DROP COLUMN bootloader;
ALTER TABLE esphub.release_assets DROP COLUMN kind, DROP COLUMN version;
CREATE VIEW esphub.board_profiles AS
  SELECT b.id, b.source_revision, b.name, b.model, b.chip, b.flash_mb,
    b.preview, b.display_order, b.default_example, s.sdk_version, s.is_current,
    b.published_examples, b.bootloader_source_url, s.sdk_source_url
  FROM esphub.boards b JOIN esphub.board_sources s ON s.revision = b.source_revision;

-- Recreating the view drops its grants. Restore them before the new Worker deploys.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'esphub_runtime') THEN
    GRANT SELECT ON esphub.board_profiles TO esphub_runtime;
  END IF;
END $$;
