ALTER TABLE esphub.devices
  ADD COLUMN kind text NOT NULL DEFAULT 'physical',
  ALTER COLUMN token_hash DROP NOT NULL,
  ALTER COLUMN transport DROP NOT NULL,
  ADD CONSTRAINT devices_kind_check CHECK (
    (kind = 'physical' AND token_hash IS NOT NULL AND transport IS NOT NULL) OR
    (kind = 'virtual' AND token_hash IS NULL AND transport IS NULL)
  );
CREATE UNIQUE INDEX devices_one_virtual_per_owner ON esphub.devices(owner) WHERE kind = 'virtual';

CREATE TABLE esphub.virtual_boots (
  device_id uuid NOT NULL REFERENCES esphub.devices ON DELETE CASCADE,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  process_id text NOT NULL DEFAULT gen_random_uuid()::text,
  request_id uuid,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  messages jsonb NOT NULL,
  PRIMARY KEY (device_id, sequence),
  UNIQUE (device_id, process_id),
  UNIQUE NULLS NOT DISTINCT (device_id, request_id)
);
