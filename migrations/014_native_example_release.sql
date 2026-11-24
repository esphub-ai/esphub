ALTER TABLE esphub.firmware_releases
  DROP CONSTRAINT firmware_releases_kind_check,
  ADD CONSTRAINT firmware_releases_kind_check
    CHECK (kind IN ('bootloader', 'micropython', 'native', 'setup'));
