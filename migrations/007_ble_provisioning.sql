-- Older registrations keep their existing USB setup until explicitly initialized.
ALTER TABLE esphub.devices
  ADD COLUMN ble_secret text,
  ADD COLUMN ble_generation integer NOT NULL DEFAULT 1,
  ADD COLUMN ble_pending text,
  ADD COLUMN ble_pending_issued boolean NOT NULL DEFAULT false,
  ADD COLUMN ble_issued boolean NOT NULL DEFAULT false;
