-- A dispatched command may already have changed hardware. Never replay it at cutover.
DROP TRIGGER close_boot_commands ON esphub.devices;
ALTER TABLE esphub.devices ADD COLUMN enrolled_boot text;
UPDATE esphub.devices SET boot_id=NULL, boot_info=NULL WHERE transport='websocket';
ALTER TABLE esphub.devices DROP CONSTRAINT devices_kind_check, DROP COLUMN transport,
  ADD CHECK ((kind='physical' AND token_hash IS NOT NULL) OR (kind='virtual' AND token_hash IS NULL));
ALTER TABLE esphub.device_commands DROP CONSTRAINT device_commands_state_check;
UPDATE esphub.device_commands SET state='unknown',args='{}',next_wake=NULL
 WHERE state IN ('claimed','executing','accepted');
ALTER TABLE esphub.device_commands ADD CHECK (state IN ('queued','dispatched','succeeded','failed','expired','unknown'));
ALTER TABLE esphub.device_commands RENAME COLUMN claimed_boot TO dispatched_boot;
ALTER TABLE esphub.device_commands DROP COLUMN lease_until;
DROP INDEX esphub.commands_open;
CREATE INDEX commands_open ON esphub.device_commands(device_id,seq) WHERE state IN ('queued','dispatched');

CREATE OR REPLACE FUNCTION esphub.close_device_commands() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE esphub.device_commands SET state='succeeded',args='{}',next_wake=NULL,
   result=jsonb_build_object('previous_boot',dispatched_boot,'observed_boot',NEW.boot_id,'role',NEW.boot_info->>'role')
 WHERE device_id=NEW.id AND operation='reboot' AND state IN ('dispatched','unknown')
   AND dispatched_boot=OLD.boot_id AND NEW.boot_id IS NOT NULL
   AND (args->>'target'='self' OR args->>'target'=NEW.boot_info->>'role');
 UPDATE esphub.device_commands SET state=CASE WHEN state='queued' THEN 'expired' ELSE 'unknown' END,
   args='{}',next_wake=NULL
 WHERE device_id=NEW.id AND ((state='queued' AND boot_id IS NOT NULL AND boot_id IS DISTINCT FROM NEW.boot_id)
 OR (state='dispatched' AND dispatched_boot IS DISTINCT FROM NEW.boot_id));
 RETURN NULL;
END $$;
CREATE TRIGGER close_boot_commands AFTER UPDATE OF boot_id ON esphub.devices
 FOR EACH ROW WHEN (OLD.boot_id IS DISTINCT FROM NEW.boot_id) EXECUTE FUNCTION esphub.close_device_commands();
