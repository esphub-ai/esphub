import { chromium } from "playwright-core";
import { simulatedDevice } from "../tests/fixtures/iot/device.mjs";
import assert from "node:assert/strict";
import { importPKCS8, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
const origin = process.env.TEST_SITE_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Expected a local TEST_SITE_URL");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});
const issuer = "https://clerk.esphub.ai";
const privateKey = await importPKCS8(process.env.TEST_SIGNING_KEY, "RS256");
// Match the signed session-token category enforced by the Clerk SDK.
const sessionHeader = {
  alg: "RS256",
  kid: "test",
  typ: "JWT",
  cat: "cl_B7d4PD111AAA",
};
const session = { sid: "sess_qa", azp: origin };
const jwt = await new SignJWT(session)
  .setProtectedHeader(sessionHeader)
  .setSubject("user_" + randomUUID().replaceAll("-", ""))
  .setIssuer(issuer)
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(privateKey);
let mcu;
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Run the production origin policy against locally signed fixture sessions.
  const subject = "user_" + randomUUID().replaceAll("-", "");
  for (const azp of [
    "https://esphub.ai",
    "https://www.esphub.ai",
    "https://app.esphub.ai",
    "https://api.esphub.ai",
    "https://untrusted.esphub.ai",
  ]) {
    const t = await new SignJWT({ sid: "sess_fixture", azp })
      .setProtectedHeader(sessionHeader)
      .setSubject(subject)
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);
    const result = await fetch(origin + "/backend/auth/me", {
      headers: {
        Origin: "https://www.esphub.ai",
        Authorization: "Bearer " + t,
      },
    });
    assert.equal(result.status, azp.includes("untrusted") ? 401 : 200);
    assert.equal(
      result.headers.get("Access-Control-Allow-Origin"),
      "https://www.esphub.ai",
    );
  }
  const invalid = await fetch(origin + "/backend/auth/me", {
    headers: { Cookie: "__session=" + jwt + "corrupt" },
  });
  assert.equal(invalid.status, 401);
  let signedIn = false;
  await page.route("https://clerk.esphub.ai/npm/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      headers: { "Access-Control-Allow-Origin": "*" },
      body:
        "window.Clerk={load:async()=>{},session:" +
        (signedIn
          ? "{getToken:async()=>" + JSON.stringify(jwt) + "}"
          : "null") +
        ",signOut:async(options)=>{if(options.redirectUrl!=='https://esphub.ai/')throw Error('Unexpected redirect');location.assign('/signed-out')}}",
    }),
  );
  await page.route("https://accounts.esphub.ai/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Hosted sign-in" }),
  );
  await page.route(origin + "/signed-out", (route) =>
    route.fulfill({ contentType: "text/html", body: "Signed out" }),
  );
  await page.goto(origin);
  await page.getByRole("heading", { name: "EspHub" }).waitFor();
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  for (const [path, accountPath] of [
    ["/sign-in", "/sign-in"],
    ["/sign-up", "/sign-up"],
  ]) {
    const response = await fetch(origin + path, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(
      new URL(response.headers.get("location")).pathname,
      accountPath,
    );
  }

  await page.getByRole("link", { name: "Open workspace" }).click();
  await page.waitForURL("https://accounts.esphub.ai/sign-in?**");
  assert.equal(
    new URL(page.url()).searchParams.get("redirect_url"),
    origin + "/devices",
  );

  signedIn = true;
  await page.goto(origin + "/devices");
  await page.getByText("No devices yet.").waitFor();

  const operate = async (name, args = {}) => {
    const response = await fetch(origin + "/backend/operations/" + name, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer " + jwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    assert.equal(response.status, 200, name);
    return response.json();
  };

  await operate("devices.create_virtual");
  const board = await operate("devices.create", {
    name: "Paper Color integration",
    board: "m5stack/paper-color",
  });
  await operate("devices.create", {
    name: "Core2 integration",
    board: "m5stack/core2",
  });
  await page.reload();

  const card = (name) =>
    page.locator('[data-slot="card"]').filter({ hasText: name });
  const pictured = card("Paper Color integration");
  await pictured.getByText("m5stack/paper-color", { exact: true }).waitFor();
  await pictured.getByText("Offline", { exact: true }).waitFor();
  assert.equal(await pictured.locator("img").count(), 1);
  await card("Core2 integration")
    .getByText("m5stack/core2", { exact: true })
    .waitFor();
  assert.equal(await card("Core2 integration").locator("img").count(), 0);
  assert.equal(await page.locator('[data-slot="card"]').count(), 2);
  assert.equal(await page.getByText("Virtual ESP32").count(), 0);
  assert.equal(
    await page.getByRole("link", { name: /Paper Color integration/ }).count(),
    0,
  );

  mcu = simulatedDevice(origin, board.token);
  await mcu.hello({ bootloader_version: "test", role: "bootloader" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pictured.getByText("Online", { exact: true }).waitFor();

  for (const [name, required] of [
    [
      "Manage devices",
      [
        "devices.list",
        "devices.get",
        "bootloader.enter",
        "ota.install",
        "devices.delete",
      ],
    ],
    ["Bind my ESP32", ["group/project", "devices.create", "devices.get"]],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    const dialog = page.getByRole("dialog", { name });
    const prompt = await dialog.getByLabel("Prompt").inputValue();
    for (const value of ["https://api.esphub.ai/mcp", ...required])
      assert.ok(prompt.includes(value), value);
    await dialog.getByRole("button", { name: "Copy prompt" }).click();
    await dialog.getByRole("button", { name: "Copied", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      prompt,
    );
    if (name === "Manage devices" && process.env.QA_MCP_SCREENSHOT)
      await page.screenshot({ path: process.env.QA_MCP_SCREENSHOT });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  if (process.env.QA_SCREENSHOT)
    await page.screenshot({ path: process.env.QA_SCREENSHOT });

  for (const path of [
    "/setup",
    "/devices/setup",
    "/explorer",
    "/device/" + board.id,
    "/setup-firmware/m5stack/paper-color/setup",
  ]) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/devices", "/terms/", "/privacy/"]) {
    await page.goto(origin + path);
    await page.getByRole("heading", { level: 1 }).waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      path,
    );
  }
  await page.goto(origin + "/devices");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(origin + "/signed-out");
  assert.deepEqual(errors, []);
  console.log(
    "PASS hosted authentication, physical device cards, live status refresh, MCP prompts, removed routes, mobile layout",
  );
} finally {
  mcu?.close();
  await browser.close();
}
