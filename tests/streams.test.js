import test from "node:test";
import assert from "node:assert/strict";
import { Stream } from "../services/api/src/streams.js";
import { validate } from "../services/api/src/operations.js";
class Bucket {
  data = new Map();
  head(k) {
    return this.data.has(k);
  }
  get(k) {
    const value = this.data.get(k);
    return value === undefined ? null : { json: () => JSON.parse(value) };
  }
  put(k, v) {
    if (this.fail === k) throw Error("storage unavailable");
    this.data.set(k, v);
  }
}
test("R2 reads cross segment boundaries without skipping records", async () => {
  const b = new Bucket(),
    s = new Stream(b, "devices/a/p/uart/tx");
  await s.init();
  await s.append(
    Array.from({ length: 68 }, (_, i) => ({ text: String(i) })),
    { source: 68 },
  );
  assert.deepEqual(
    (await s.read(63)).records.map((r) => r.seq),
    [64, 65, 66, 67, 68],
  );
  assert.equal((await s.read(68)).cursor, 68);
});
test("a failed manifest commit cannot expose or duplicate abandoned input", async () => {
  const b = new Bucket(),
    s = new Stream(b, "rx");
  await s.init();
  await s.append([{ text: "one" }]);
  b.fail = "rx";
  await assert.rejects(() => s.append([{ text: "failed" }]));
  assert.equal((await s.read(1)).records.length, 0);
  b.fail = null;
  await s.append([{ text: "two" }]);
  assert.deepEqual(
    (await s.read(0)).records.map((r) => r.text),
    ["one", "two"],
  );
});
test("reject invalid boards and insecure firmware URLs", () => {
  assert.throws(() =>
    validate("devices.create", { name: "x", board: "esp32s3" }),
  );
  assert.throws(() =>
    validate("ota.install", {
      device_id: crypto.randomUUID(),
      url: "http://e.test/a",
      kind: "bootloader",
    }),
  );
});
