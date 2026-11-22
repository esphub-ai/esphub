ALTER TABLE esphub.devices
 ADD COLUMN transport text NOT NULL DEFAULT 'websocket' CHECK (transport IN ('websocket','mqtt')),
 ADD COLUMN command_seq bigint NOT NULL DEFAULT 0,
 ADD COLUMN boot_id text,
 ADD COLUMN boot_info jsonb,
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
