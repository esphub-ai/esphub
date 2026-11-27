-- Clerk subjects identify accounts. The handle was a placeholder left from passkey sign-in.
ALTER TABLE esphub.accounts DROP COLUMN handle;

-- The Hub serves published_examples, and the firmware publisher no longer writes the raw examples.
DROP VIEW esphub.board_profiles;
ALTER TABLE esphub.boards DROP COLUMN examples;
CREATE VIEW esphub.board_profiles AS
  SELECT b.id, b.source_revision, b.name, b.model, b.chip, b.flash_mb, b.bootloader,
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
