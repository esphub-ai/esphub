-- This release replaces the device protocol, the factory kits and the board catalog.
-- Firmware CI republishes the catalog and releases after this migration.
DELETE FROM esphub.devices WHERE kind = 'physical';
DELETE FROM esphub.firmware_releases;
DELETE FROM esphub.boards;
DELETE FROM esphub.board_sources;

DROP VIEW esphub.board_profiles;
ALTER TABLE esphub.firmware_releases DROP CONSTRAINT firmware_releases_kind_check,
  ADD CHECK (kind IN ('bootloader', 'app', 'setup'));
ALTER TABLE esphub.board_sources DROP COLUMN upstream_repository, DROP COLUMN upstream_ref;
ALTER TABLE esphub.boards DROP COLUMN runtime, DROP COLUMN hello, DROP COLUMN has_setup,
  ADD COLUMN default_example text NOT NULL,
  ADD COLUMN examples jsonb NOT NULL CHECK (jsonb_typeof(examples) = 'array');
CREATE VIEW esphub.board_profiles AS
  SELECT b.*, s.sdk_version, s.is_current
  FROM esphub.boards b JOIN esphub.board_sources s ON s.revision = b.source_revision;
