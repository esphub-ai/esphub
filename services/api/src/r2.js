// Shared R2 S3-compatible signing and server-side CopyObject helpers for
// firmware and project asset publishing.
import { AwsClient, AwsV4Signer } from "aws4fetch";
import { fail } from "./auth.js";

const defaultBucket = "esphub-firmware";
export const uploadExpirySeconds = 900;
export const stagingKey = (uploadId) => `staging/uploads/${uploadId}`;

export function r2Config(env) {
  const endpoint =
    env.FIRMWARE_R2_ENDPOINT ||
    (env.CLOUDFLARE_ACCOUNT_ID
      ? `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : null);
  const bucket = env.FIRMWARE_R2_BUCKET || defaultBucket;
  if (
    !env.FIRMWARE_R2_ACCESS_KEY_ID ||
    !env.FIRMWARE_R2_SECRET_ACCESS_KEY ||
    !endpoint
  )
    fail(503, "Firmware storage credentials unavailable");
  return {
    accessKeyId: env.FIRMWARE_R2_ACCESS_KEY_ID,
    secretAccessKey: env.FIRMWARE_R2_SECRET_ACCESS_KEY,
    aws: new AwsClient({
      accessKeyId: env.FIRMWARE_R2_ACCESS_KEY_ID,
      secretAccessKey: env.FIRMWARE_R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
      retries: 0,
    }),
    endpoint,
    bucket,
  };
}

export async function signPresignedPut(
  s3,
  { key, expiresSeconds = uploadExpirySeconds, contentType, contentLength },
) {
  const url = new URL(`${s3.bucket}/${key}`, s3.endpoint);
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const headers = {};
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  if (contentLength !== undefined) headers["Content-Length"] = String(contentLength);
  const signer = new AwsV4Signer({
    method: "PUT",
    url: url.toString(),
    headers,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    service: "s3",
    region: "auto",
    signQuery: true,
    allHeaders: contentType !== undefined || contentLength !== undefined,
  });
  const signed = await signer.sign();
  return signed.url.toString();
}

export async function copyStagedObject(
  env,
  s3,
  {
    label,
    srcKey,
    destKey,
    contentType = "application/octet-stream",
    expectedSize,
    expectedSha,
  },
) {
  const existing = await env.FIRMWARE.head(destKey);
  if (existing) {
    const existingType = existing.httpMetadata?.contentType;
    if (
      existing.size === expectedSize &&
      existing.customMetadata?.sha256 === expectedSha &&
      (!existingType || existingType === contentType)
    )
      return;
    fail(409, `Published object already exists with different content: ${label}`);
  }
  const destUrl = new URL(`${s3.bucket}/${destKey}`, s3.endpoint);
  const res = await s3.aws.fetch(destUrl, {
    method: "PUT",
    headers: {
      "x-amz-copy-source": `/${s3.bucket}/${srcKey}`,
      "x-amz-metadata-directive": "REPLACE",
      "Content-Type": contentType,
      "x-amz-meta-sha256": expectedSha,
      "If-None-Match": "*",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 412) {
    const raced = await env.FIRMWARE.head(destKey);
    const racedType = raced?.httpMetadata?.contentType;
    if (
      raced?.size === expectedSize &&
      raced.customMetadata?.sha256 === expectedSha &&
      (!racedType || racedType === contentType)
    )
      return;
    fail(409, `Published object already exists with different content: ${label}`);
  }
  if (!res.ok) fail(502, `Failed to move object: ${label}`);
}
