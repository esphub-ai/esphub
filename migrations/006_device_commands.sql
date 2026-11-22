ALTER TABLE esphub.devices
 ADD COLUMN transport text NOT NULL DEFAULT 'websocket' CHECK (transport IN ('websocket','mqtt')),
 ADD COLUMN command_seq bigint NOT NULL DEFAULT 0,
 ADD COLUMN boot_id text,
 ADD COLUMN boot_info jsonb,
 ADD COLUMN cert_ready boolean NOT NULL DEFAULT false,
 ADD COLUMN cert_id text,
 ADD COLUMN cert_csr text,
 ADD COLUMN cert_pem text;

CREATE TABLE esphub.device_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 device_id uuid NOT NULL REFERENCES esphub.devices ON DELETE CASCADE,
 seq bigint NOT NULL,
 request_id uuid NOT NULL,
 operation text NOT NULL,
 args jsonb NOT NULL,
 fingerprint text NOT NULL,
 boot_id text,
 claimed_boot text,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
 lease_until timestamptz,
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','executing','accepted','succeeded','failed','expired','unknown')),
 result jsonb,
 next_wake timestamptz DEFAULT now(),
 UNIQUE(device_id,request_id), UNIQUE(device_id,seq)
);
CREATE INDEX commands_due ON esphub.device_commands(next_wake) WHERE next_wake IS NOT NULL;
CREATE INDEX commands_open ON esphub.device_commands(device_id,seq) WHERE state IN ('queued','claimed','executing');

-- Preserve revocation work across a deleted registration or interrupted request.
CREATE TABLE esphub.iot_revocations (
 cert_id text PRIMARY KEY,
 device_id uuid NOT NULL,
 retry_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION esphub.retire_device_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.cert_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.cert_id IS DISTINCT FROM OLD.cert_id) THEN
   INSERT INTO esphub.iot_revocations(cert_id,device_id) VALUES(OLD.cert_id,OLD.id) ON CONFLICT DO NOTHING;
 END IF;
 IF TG_OP='UPDATE' AND NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
   DELETE FROM esphub.device_commands WHERE device_id=OLD.id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER retire_device_certificate AFTER UPDATE OF cert_id,token_hash OR DELETE ON esphub.devices
 FOR EACH ROW EXECUTE FUNCTION esphub.retire_device_certificate();

CREATE FUNCTION esphub.close_device_commands() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE esphub.device_commands SET state='succeeded',args='{}',next_wake=NULL,
   result=jsonb_build_object('previous_boot',claimed_boot,'observed_boot',NEW.boot_id,'role',NEW.boot_info->>'role')
 WHERE device_id=NEW.id AND operation='reboot' AND state='accepted'
   AND NEW.boot_id IS NOT NULL AND claimed_boot IS DISTINCT FROM NEW.boot_id
   AND (args->>'target'='self' OR args->>'target'=NEW.boot_info->>'role');
 UPDATE esphub.device_commands
 SET state=CASE WHEN state='executing' THEN 'unknown' ELSE 'expired' END,
     args='{}',next_wake=NULL
 WHERE device_id=NEW.id AND state IN ('queued','claimed','executing')
 AND (NEW.transport='websocket' OR (boot_id IS NOT NULL AND boot_id IS DISTINCT FROM NEW.boot_id)
      OR (state='executing' AND claimed_boot IS DISTINCT FROM NEW.boot_id));
 RETURN NULL;
END $$;
CREATE TRIGGER close_boot_commands AFTER UPDATE OF transport,boot_id ON esphub.devices
 FOR EACH ROW WHEN (OLD.transport IS DISTINCT FROM NEW.transport OR OLD.boot_id IS DISTINCT FROM NEW.boot_id)
 EXECUTE FUNCTION esphub.close_device_commands();
