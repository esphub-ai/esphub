ALTER TABLE esphub.devices DROP CONSTRAINT devices_board_check;

-- The complete set of registered board IDs before this migration.
WITH board_ids(board) AS (
  SELECT 'm5stack/' || project FROM unnest(ARRAY[
    'airq', 'atom-psram', 'atom-voices3r', 'atoms3', 'atoms3-lite', 'atoms3r', 'atoms3r-cam',
    'atoms3r-ext', 'atoms3u', 'basic-v27', 'capsule', 'cardputer', 'cardputer-adv',
    'chain-captain', 'chain-dualkey', 'core2', 'corematrix', 'cores3', 'dial', 'dinmeter',
    'fire-v27', 'nesso-n1', 'paper-color', 'paper-diy', 'paper-v11', 'papermono',
    'papermono-lite', 'papers3', 'powerhub', 'stackchan', 'stamp-c6lora', 'stamp-s3',
    'stamp-s3bat', 'stamplc', 'station', 'stickc-plus2', 'sticks3', 'stopwatch', 'tough',
    'toughc5', 'triviapod', 'unit-c6l', 'unit-cams3-5mp', 'unit-poe-cam-w-v11', 'vameter',
    'xiaozhi-card'
  ]) AS projects(project)
  UNION ALL VALUES ('espressif/esp-mosaico'), ('esphub/virtual-esp32')
)
UPDATE esphub.devices d
SET board = b.board,
    boot_info = CASE WHEN d.boot_info ? 'board'
                THEN jsonb_set(d.boot_info, '{board}', to_jsonb(b.board))
                ELSE d.boot_info END
FROM board_ids b
WHERE d.board = split_part(b.board, '/', 2);

ALTER TABLE esphub.devices ADD CONSTRAINT devices_board_check
  CHECK (board ~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$');

-- A dispatched install may already be writing flash. Keep its transfer ID so
-- the eventual device receipt can resolve its outcome without a replay.
UPDATE esphub.device_commands SET
  state = CASE WHEN state = 'queued' THEN 'expired' ELSE 'unknown' END,
  args = '{}', next_wake = NULL
WHERE operation = 'install' AND state IN ('queued', 'dispatched')
  AND position('/' IN (args->>'board')) = 0;

-- Old release tags name different files and MicroPython image descriptors.
-- The publisher supplies the catalog rows for the newly built images.
DELETE FROM esphub.firmware_releases WHERE position('/' IN board) = 0;
