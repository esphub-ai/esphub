-- The API validates registrations against the board profiles bundled with this deployment.
ALTER TABLE esphub.devices DROP CONSTRAINT devices_board_check;
ALTER TABLE esphub.devices ADD CONSTRAINT devices_board_check CHECK (board ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
