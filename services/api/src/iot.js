import { AwsClient } from "aws4fetch";
import { fail } from "./auth.js";
const region = "us-west-2";
const isWestEndpoint = (host) =>
  typeof host === "string" &&
  /^[a-z0-9-]+-ats\.iot\.us-west-2\.amazonaws\.com$/.test(host);
const policy = "ESPHubDeviceWake";
function configured(env) {
  return Boolean(
    env.IOT_ACCESS_KEY_ID &&
    env.IOT_SECRET_ACCESS_KEY &&
    isWestEndpoint(env.IOT_DATA_ENDPOINT) &&
    /^\d{12}$/.test(env.IOT_ACCOUNT_ID),
  );
}
async function request(env, host, path, method, body, service, headers = {}) {
  if (!configured(env)) fail(503, "IoT credentials unavailable");
  const client = new AwsClient({
    accessKeyId: env.IOT_ACCESS_KEY_ID,
    secretAccessKey: env.IOT_SECRET_ACCESS_KEY,
    region,
    service,
    retries: 0,
  });
  const response = await client.fetch("https://" + host + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json", ...headers },
  });
  if (
    response.status === 404 &&
    (method === "GET" ||
      (method === "PUT" && path.endsWith("?newStatus=INACTIVE")))
  )
    return null;
  if (!response.ok) throw Error("IoT request failed (" + response.status + ")");
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
const control = (env, path, method, body, headers) =>
  request(
    env,
    "iot." + region + ".amazonaws.com",
    path,
    method,
    body,
    "iot",
    headers,
  );
export async function connectedSince(env, id) {
  const connection = await request(
    env,
    env.IOT_DATA_ENDPOINT,
    "/connections/esphub-" + id,
    "GET",
    undefined,
    "iotdata",
  );
  return connection?.connected === true ? connection.connectedSince : null;
}
export function publishDownlink(env, id, payload) {
  return request(
    env,
    env.IOT_DATA_ENDPOINT,
    "/topics/" + encodeURIComponent("devices/" + id + "/wake") + "?qos=1",
    "POST",
    payload,
    "iotdata",
  );
}
export async function revokeCertificate(env, id) {
  if (id)
    await control(env, "/certificates/" + id + "?newStatus=INACTIVE", "PUT");
}
export async function enroll(env, db, id, hash, csr) {
  if (!configured(env)) fail(503, "IoT credentials unavailable");
  if (
    typeof csr !== "string" ||
    csr.length > 4096 ||
    !/^-----BEGIN CERTIFICATE REQUEST-----[\s\S]+-----END CERTIFICATE REQUEST-----\s*$/.test(
      csr,
    )
  )
    fail(400, "Invalid CSR");
  let [saved] =
    await db`SELECT cert_id,cert_pem,cert_csr,cert_ready FROM esphub.devices WHERE id=${id} AND token_hash=${hash}`;
  if (!saved) fail(401, "Device token changed");
  if ((saved.cert_id || saved.cert_csr) && saved.cert_csr !== csr)
    fail(409, "Reissue the device token before replacing its key");
  if (!saved.cert_id) {
    // Start INACTIVE. An interrupted enrollment cannot leave an authorized orphan.
    const cert = await control(env, "/certificates?setAsActive=false", "POST", {
      certificateSigningRequest: csr,
    });
    [saved] =
      await db`UPDATE esphub.devices SET cert_id=${cert.certificateId},cert_pem=${cert.certificatePem},cert_csr=${csr}
      WHERE id=${id} AND token_hash=${hash} AND cert_id IS NULL RETURNING cert_id,cert_pem,cert_ready`;
    if (!saved) {
      await control(env, "/certificates/" + cert.certificateId, "DELETE");
      fail(409, "Enrollment changed; retry");
    }
  }
  const enrollment = {
    device_id: id,
    endpoint: env.IOT_DATA_ENDPOINT,
    certificate: saved.cert_pem,
  };
  if (saved.cert_ready) return enrollment;
  const arn =
    "arn:aws:iot:" +
    region +
    ":" +
    env.IOT_ACCOUNT_ID +
    ":cert/" +
    saved.cert_id;
  const thing = "esphub-" + id;
  await control(env, "/things/" + thing, "POST", {
    attributePayload: { attributes: { deviceId: id } },
  });
  // CreateThing is idempotent for the same attributes.
  await control(env, "/things/" + thing + "/principals", "PUT", undefined, {
    "x-amzn-principal": arn,
  });
  await control(env, "/target-policies/" + policy, "PUT", { target: arn });
  await control(
    env,
    "/certificates/" + saved.cert_id + "?newStatus=ACTIVE",
    "PUT",
  );
  const [valid] =
    await db`UPDATE esphub.devices SET cert_ready=true WHERE id=${id} AND token_hash=${hash} AND cert_id=${saved.cert_id} RETURNING id`;
  if (!valid) {
    await revokeCertificate(env, saved.cert_id);
    fail(409, "Registration changed");
  }
  return enrollment;
}
