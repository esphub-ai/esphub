import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { enroll, publishDownlink } from "../services/api/src/iot.js";
import { retryDue } from "../services/api/src/commands.js";

test(
  "resume enrollment after an interrupted policy attachment, then retire the certificate",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = postgres(process.env.TEST_DATABASE_URL),
      id = crypto.randomUUID(),
      hash = crypto.randomUUID();
    const env = {
      IOT_DATA_ENDPOINT: "fixture-ats.iot.us-west-2.amazonaws.com",
      IOT_ACCESS_KEY_ID: "fixture",
      IOT_SECRET_ACCESS_KEY: "test",
      IOT_ACCOUNT_ID: "000000000000",
    };
    const csr =
      "-----BEGIN CERTIFICATE REQUEST-----\nfixture\n-----END CERTIFICATE REQUEST-----";
    const calls = [];
    let deny = true;
    t.mock.method(globalThis, "fetch", async (req) => {
      const url = new URL(req.url);
      calls.push([req.method, url.pathname, url.search]);
      assert.ok(req.headers.get("Authorization")?.includes("/us-west-2/"));
      if (url.pathname === "/certificates")
        return Response.json({
          certificateId: "1".repeat(64),
          certificatePem: "fixture-pem",
        });
      if (url.pathname.startsWith("/target-policies/") && deny)
        return new Response(null, { status: 403 });
      return Response.json({});
    });
    const [owner] =
      await db`INSERT INTO esphub.accounts(clerk_subject) VALUES(${"user_" + crypto.randomUUID().replaceAll("-", "")}) RETURNING id`;
    try {
      await db`INSERT INTO esphub.devices(id,owner,name,board,token_hash) VALUES(${id},${owner.id},'fixture','m5stack/stopwatch',${hash})`;
      await assert.rejects(enroll(env, db, id, hash, csr), /403/);
      assert.ok(!calls.some((c) => c[2] === "?newStatus=ACTIVE"));
      deny = false;
      assert.equal((await enroll(env, db, id, hash, csr)).device_id, id);
      const count = calls.length;
      assert.equal(
        (await enroll(env, db, id, hash, csr)).certificate,
        "fixture-pem",
      );
      assert.equal(calls.length, count);
      assert.equal(calls.filter((c) => c[1] === "/certificates").length, 1);
      await assert.rejects(
        enroll(env, db, id, hash, csr.replace("fixture", "different-key")),
        /Reissue the device token/,
      );
      assert.equal(calls.length, count);
      await publishDownlink(env, id, { boot_id: "boot", mid: 42 });
      assert.deepEqual(calls.at(-1), [
        "POST",
        "/topics/" + encodeURIComponent("devices/" + id + "/wake"),
        "?qos=1",
      ]);
      await db`DELETE FROM esphub.devices WHERE id=${id}`;
      await retryDue(db, env, id);
      assert.equal(calls.at(-1)[2], "?newStatus=INACTIVE");
      assert.equal(
        (
          await db`SELECT cert_id FROM esphub.iot_revocations WHERE device_id=${id}`
        ).length,
        0,
      );
    } finally {
      await db`DELETE FROM esphub.accounts WHERE id=${owner.id}`;
      await db.end();
    }
  },
);
