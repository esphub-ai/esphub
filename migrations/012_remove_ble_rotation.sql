ALTER TABLE esphub.devices
  DROP COLUMN ble_generation,
  DROP COLUMN ble_pending,
  DROP COLUMN ble_pending_issued,
  DROP COLUMN ble_issued;
