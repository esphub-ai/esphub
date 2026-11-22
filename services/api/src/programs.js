import { digest, fail } from "./auth.js";

export const programByteLimit = 32 * 1024;

// Device frames are limited to 8 KiB, including JSON and base64 overhead.
const chunkSize = 4096;
export async function installProgram(source, rpc) {
  const bytes = Buffer.from(source, "utf8");
  const sha256 = await digest(source);
  async function run(code) {
    // A live main.py may already use names such as os, f or data.
    const result = await rpc("py.exec", {
      code: "exec(" + JSON.stringify(code) + ", {})",
    });
    if (result?.exception !== null)
      fail(
        409,
        result?.exception || "MicroPython did not acknowledge the write",
      );
    return result.output;
  }
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize).toString("base64");
    await run(`import binascii
with open('/flash/.esphub-upload', '${offset ? "ab" : "wb"}') as f:
    f.write(binascii.a2b_base64('${chunk}'))`);
  }
  const output = await run(`import os, hashlib, binascii
stage = '/flash/.esphub-upload'
with open(stage, 'rb') as f:
    data = f.read()
checksum = binascii.hexlify(hashlib.sha256(data).digest()).decode()
if checksum != '${sha256}':
    raise ValueError('Program checksum mismatch')
compile(data.decode(), '/flash/main.py', 'exec')
os.rename(stage, '/flash/main.py')
print(checksum)`);
  if (output?.trim() !== sha256)
    fail(502, "Missing on-device checksum receipt");
  const receipt = {
    verified: true,
    path: "/flash/main.py",
    bytes: bytes.length,
    sha256,
  };
  try {
    await rpc("py.reset", {});
    return { ...receipt, restart: "acknowledged" };
  } catch (error) {
    return { ...receipt, restart: "unconfirmed", detail: error.message };
  }
}
