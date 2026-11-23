ALTER TABLE esphub.devices DROP COLUMN enrolled_boot, ADD COLUMN mqtt_connected_since bigint;
ALTER TABLE esphub.device_commands ADD COLUMN delivery_deadline timestamptz;
-- Old dispatches no longer have a payload to deliver. Never execute them again.
UPDATE esphub.device_commands SET state='unknown', next_wake=NULL WHERE state='dispatched';
