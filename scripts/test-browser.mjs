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
        ",signOut:async()=>location.assign('/signed-out')}",
    }),
  );
  await page.route("https://accounts.esphub.ai/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Hosted sign-in" }),
  );
  await page.goto(origin);
  await page.getByRole("heading", { name: /Bring HMR to ESP32/ }).waitFor();
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.getByRole("button", { name: "Copy prompt" }).click();
  const setupPrompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(setupPrompt, await page.locator("#prompt").innerText());
  assert.ok(setupPrompt.includes("https://api.esphub.ai/mcp"));
  await page.getByRole("link", { name: "Open workspace" }).click();
  await page.waitForURL("https://accounts.esphub.ai/sign-in?**");
  assert.equal(
    new URL(page.url()).searchParams.get("redirect_url"),
    origin + "/devices",
  );
  signedIn = true;
  await page.goto(origin + "/devices");
  const copyPrompt = page.getByRole("button", {
    name: "Copy prompt",
    exact: true,
  });
  await page
    .getByRole("region", { name: "Use EspHub with your assistant" })
    .waitFor();
  assert.equal(await copyPrompt.count(), 1);
  await copyPrompt.click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(prompt, await page.locator("#mcp-prompt").textContent());
  for (const required of [
    "https://api.esphub.ai/mcp",
    "CIMD OAuth",
    "devices:read",
    "devices:write",
    "devices.create",
    "programs.publish",
    "bootloader.enter",
    "ota.install",
  ])
    assert.ok(prompt.includes(required));
  if (process.env.QA_MCP_SCREENSHOT)
    await page.screenshot({
      path: process.env.QA_MCP_SCREENSHOT,
      fullPage: true,
    });
  await page.goto(origin + "/devices");
  await page.getByRole("button", { name: "Create virtual ESP32" }).click();
  await page.getByRole("heading", { name: "Virtual ESP32" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Wi-Fi", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Firmware", exact: true }).click();
  await page.getByRole("definition").filter({ hasText: "1.0.0" }).waitFor();
  await page.getByRole("button", { name: "Inspect device" }).click();
  await page
    .locator("#out")
    .filter({ hasText: /EspHub virtual firmware/ })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Install from URL" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Reboot", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("link", { name: "← Devices" }).click();
  await page
    .getByRole("link", { name: /Virtual ESP32.*Simulated ESP32/ })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete device", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Create virtual ESP32" }).waitFor();
  await page.getByText("+ Add device").click();
  await page.locator("[name=name]").fill("Paper Color · integration");
  await page.locator("[name=board]").selectOption("paper-color");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  const token = JSON.parse(
    await page.locator("dialog pre").textContent(),
  ).token;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".device").first().click();
  mcu = simulatedDevice(origin, token);
  await mcu.hello({
    board: "paper-color",
    chip: "esp32s3",
    image_profile: "ESPHUB2/bootloader/esp32s3-16mb",
    fw: { name: "bootloader", version: "test" },
    role: "bootloader",
  });
  await page.reload();
  if (process.env.QA_SCREENSHOT)
    await page.screenshot({ path: process.env.QA_SCREENSHOT });
  await page.getByRole("button", { name: "Firmware", exact: true }).click();
  await page
    .getByRole("button", { name: "Enter Bootloader mode", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Install from URL", exact: true })
    .click();
  assert.deepEqual(
    await page
      .locator('[name="kind"] option')
      .evaluateAll((options) => options.map((o) => o.value)),
    ["python", "native", "micropython", "bootloader"],
  );
  await page.locator('[name="url"]').fill("https://example.org/main.py");
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const install = await mcu.nextCommand();
  const sha256 = "ab".repeat(32);
  await mcu.send({t:"event", name:"install.done", data:{
    kind:"python", transfer_id:install.args.transfer_id, sha256, bytes:10
  }});
  await page.getByText("Install completed.").waitFor();
  await mcu.hello({
    role: "app", bootloader_version: "1.1.17",
    runtime_type: "micropython", runtime_version: "1.1.18",
  });
  await page.getByRole("button", { name: "Firmware", exact: true }).click();
  await page.getByText("1.1.17", { exact: true }).waitFor();
  await page.getByText("Runtime type", { exact: true }).waitFor();
  await page.getByText("1.1.18", { exact: true }).waitFor();
  await page.locator("#program").filter({hasText:sha256}).waitFor();
  assert.match(await page.locator("#program").textContent(), new RegExp(install.args.transfer_id));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete device", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText(/No devices found/).waitFor();
  await page.goto(origin + "/explorer");
  await page.getByRole("button", { name: "Run tool" }).click();
  await page.locator("#result").filter({ hasText: "[]" }).waitFor();
  await page.goto(origin + "/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(origin + "/signed-out");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ["/", "/devices", "/setup", "/mcp"]) {
    await page.goto(origin + p);
    await page.locator("h1").waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      p,
    );
  }
  await page.goto(origin + "/setup?board=stopwatch");
  assert.equal(
    await page
      .getByRole("link", { name: "First-time USB kit" })
      .getAttribute("href"),
    "https://api.esphub.ai/releases/stopwatch/setup",
  );
  assert.equal(
    await page.getByRole("link", { name: "Bootloader OTA image" }).count(),
    0,
  );
  await page.getByText("Firmware downloads", { exact: true }).click();
  assert.equal(
    await page.getByRole("link", { name: "Bootloader OTA image" }).count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("link", { name: "MicroPython OTA image" })
      .getAttribute("href"),
    "https://api.esphub.ai/releases/stopwatch/micropython",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS hosted sign-in and sign-up routing, signed session verification, virtual board creation, MQTT installation, tool explorer, deletion, mobile navigation",
  );
} finally {
  mcu?.close();
  await browser.close();
}
