-- Optional custom tail partition layout and raw data partition images per project release.

ALTER TABLE esphub.project_releases
  ADD COLUMN IF NOT EXISTS app_slot_size integer
  CHECK (app_slot_size IS NULL OR (app_slot_size >= 65536 AND app_slot_size % 65536 = 0));

CREATE TABLE IF NOT EXISTS esphub.project_release_partitions (
  project_id   uuid NOT NULL,
  board_id     text NOT NULL,
  version      text NOT NULL,
  position     integer NOT NULL CHECK (position >= 0),
  label        text NOT NULL CHECK (label ~ '^[A-Za-z0-9._-]{1,15}$' AND label <> 'app'),
  type         smallint NOT NULL DEFAULT 1 CHECK (type = 1),
  subtype      smallint NOT NULL CHECK (subtype >= 0 AND subtype <= 254),
  size         integer NOT NULL CHECK (size >= 4096 AND size % 4096 = 0),
  object_key   text,
  image_size   integer CHECK (image_size IS NULL OR (image_size > 0 AND image_size <= size)),
  image_sha256 text CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
  upload_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, board_id, version, label),
  UNIQUE (project_id, board_id, version, position),
  CHECK (
    (object_key IS NULL AND image_size IS NULL AND image_sha256 IS NULL AND upload_id IS NULL)
    OR
    (object_key IS NOT NULL AND image_size IS NOT NULL AND image_sha256 IS NOT NULL AND upload_id IS NOT NULL)
  ),
  FOREIGN KEY (project_id, board_id, version)
    REFERENCES esphub.project_releases (project_id, board_id, version) ON DELETE CASCADE
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'esphub_runtime') THEN
    GRANT SELECT, INSERT ON esphub.project_release_partitions TO esphub_runtime;
  END IF;
END $$;
