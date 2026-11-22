# MQTT device command delivery

The API stores commands in Neon. An authenticated device subscribes at QoS 1 to
`devices/<device UUID>/wake` in AWS IoT Core, us-west-2. A wake contains only
`{"pending":true}`. After SUBACK and on each notification, the device pulls over
HTTPS using its existing ESPHub token. The launcher and MicroPython use the same
agent and device identity. Serial output and uploaded artifacts use the existing
R2 paths.

## Deployment

1. Apply `deploy/iot.yaml` to the target account in us-west-2 with CloudFormation.
   The stack creates the thing-bound device policy and outputs the managed policy
   ARN for the Worker identity. Attach the managed policy to the dedicated backend
   principal. The AWS enrollment principal can administer certificates in this
   region. Use a dedicated IoT account if certificates for other workloads need
   independent administration.
2. Set production environment variables `IOT_ACCOUNT_ID` and `IOT_DATA_ENDPOINT`
   in GitHub. Use the hostname reported by `aws iot describe-endpoint
   --endpoint-type iot:Data-ATS --region us-west-2` in the target account.
   Set environment secrets `IOT_ACCESS_KEY_ID` and `IOT_SECRET_ACCESS_KEY`
   for that principal. Temporary credentials additionally need `IOT_SESSION_TOKEN`
   and rotation before expiry. The production workflow deploys these as Worker
   bindings. No device receives AWS backend credentials.
3. Deploy the migration and Worker before rolling out firmware. The new agent
   probes the authenticated capabilities endpoint after obtaining Wi-Fi.
   A configured Worker advertises MQTT. Unconfigured and older backends retain
   the WebSocket path. The device generates a P-256 private key and CSR in NVS.
   Only the CSR is sent to the backend. IoT creates an inactive certificate,
   binds it to the thing and its subscribe-only policy, then activates it.
4. Test one device through USB provisioning, initial enrollment, both boot roles,
   a temporarily disconnected network, and token replacement. Verify that
   publishing or subscribing to another device's topic is denied. A legacy
   firmware connecting over its authenticated WebSocket switches that device
   back to the legacy channel.

## Receipts and recovery

Callers can supply a UUID `request_id` when submitting a command. Reuse the ID
for retries of the same payload. MQTT-enabled operations return `command_id`;
use `commands.get` with the device ID to read the outcome. Commands expire after
five minutes in the queue. Four consecutive commands at most are leased per pull.
Before executing each one the device exchanges its lease for a one-time start
permission. A lost pull can be retried. Loss of contact after start yields
`unknown` instead of an automatic second execution. Serial input belongs to
one boot. An OTA acceptance is followed by the matching install event; check the
new boot and running firmware before reporting deployment success.

Each device's existing Durable Object arms its alarm before inserting into Neon.
Postgres records when another wake is due. The alarm retries pending work and
stops once the device is settled. A six-hour indexed sweep recovers interrupted
alarms and certificate revocations. A token replacement invalidates pending
commands and schedules deactivation of the old certificate. No D1 database is
required.
