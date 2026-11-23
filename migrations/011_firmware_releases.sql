CREATE TABLE esphub.firmware_releases (
  board text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bootloader', 'micropython', 'setup')),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  manifest jsonb,
  PRIMARY KEY (board, kind),
  CHECK ((kind = 'bootloader') = (manifest IS NOT NULL))
);
