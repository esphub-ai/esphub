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
const user = "user_" + randomUUID().replaceAll("-", "");
const jwt = await new SignJWT(session)
  .setProtectedHeader(sessionHeader)
  .setSubject(user)
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
  const devicesList = (headers) =>
    fetch(origin + "/backend/operations/devices_list", {
      method: "POST",
      headers: { Origin: "https://www.esphub.ai", "Content-Type": "application/json", ...headers },
      body: "{}",
    });
  for (const [azp, status] of [
    ["https://esphub.ai", 200],
    ["https://www.esphub.ai", 200],
    ["https://app.esphub.ai", 200],
    ["https://api.esphub.ai", 401],
    ["https://untrusted.esphub.ai", 401],
  ]) {
    const t = await new SignJWT({ sid: "sess_fixture", azp })
      .setProtectedHeader(sessionHeader)
      .setSubject(subject)
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(privateKey);
    assert.equal((await devicesList({ Authorization: "Bearer " + t })).status, status, azp);
  }
  assert.equal((await devicesList({ Authorization: "Bearer " + jwt + "corrupt" })).status, 401);
  assert.equal((await devicesList({})).status, 401);
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
  // Route the CDN hostname to the local Worker's real R2 and Images bindings.
  const photoRequests = [];
  await page.route("https://cdn.esphub.ai/boards/**", async (route) => {
    const url = new URL(route.request().url());
    photoRequests.push(url);
    const response = await page.request.get(origin + "/backend/__cdn" + url.pathname + url.search);
    await route.fulfill({ response });
  });
  await page.goto(origin);
  await page.getByRole("heading", { name: "Vibe OTA your ESP32." }).waitFor();
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const skill = await page.request.get(origin + "/SKILL.md");
  assert.equal(skill.status(), 200);
  assert.match(await skill.text(), /Client ID Metadata Document \(CIMD\)/);
  await page.getByRole("button", { name: "Connect EspHub" }).click();
  await page.getByRole("button", { name: "Cursor", exact: true }).click();
  const connect = page.getByRole("dialog", { name: "Connect EspHub" });
  await connect.getByText(/Paste this prompt into Cursor/).waitFor();
  await connect.getByRole("button", { name: "Copy prompt" }).click();
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /https:\/\/esphub\.ai\/SKILL\.md/,
  );
  await page.keyboard.press("Escape");
  const gallery = page.getByRole("region", { name: "Board gallery" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const boards = await (await page.request.get(origin + "/backend/boards/gallery")).json();
  const selected = boards.find(({ id }) => id === "m5stack/stopwatch");
  assert.ok(selected);
  assert.equal(await gallery.locator(".lane-cycle:not(.lane-copy) button").count(), boards.length);
  await page.getByRole("link", { name: `Explore ${boards.length} boards` }).click();
  const tile = gallery.getByRole("button", { name: selected.model, exact: true });
  await tile.scrollIntoViewIfNeeded();
  const thumbnail = await tile.locator("img").evaluate(async (img) => {
    await img.decode();
    const source = new Image();
    source.src = img.currentSrc;
    await source.decode();
    return { src: source.src, width: source.naturalWidth, height: source.naturalHeight };
  });
  const requestedWidth = Number(new URL(thumbnail.src).searchParams.get("width"));
  assert.equal(new URL(thumbnail.src).origin, "https://cdn.esphub.ai");
  assert.ok(requestedWidth > 0 && requestedWidth <= 320);
  assert.equal(Math.max(thumbnail.width, thumbnail.height), requestedWidth);
  assert.ok(photoRequests.length > 0 && photoRequests.every((url) => url.searchParams.has("width")));
  await tile.click();
  const product = page.getByRole("dialog", { name: selected.name, exact: true });
  await product.getByRole("img", { name: selected.model }).evaluate((img) => img.decode());
  assert.ok(photoRequests.some((url) => url.href === selected.image_url));
  assert.equal(await product.getByRole("link", { name: "Product page" }).getAttribute("href"), selected.product_url);
  await product.getByRole("button", { name: "Connect to my coding agent" }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await connect.getByRole("button", { name: "Copy prompt" }).click();
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes(selected.id));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.getByRole("link", { name: "Privacy Policy" }).scrollIntoViewIfNeeded();
  assert.ok(await gallery.locator(".wall-row").first().evaluate((row) => row.getBoundingClientRect().bottom <= 0));
  await page.getByRole("link", { name: "Open workspace" }).click();
  await page.waitForURL("https://accounts.esphub.ai/sign-in?**");
  assert.equal(
    new URL(page.url()).searchParams.get("redirect_url"),
    origin + "/devices",
  );

  signedIn = true;
  await page.goto(origin + "/devices");
  await page.getByText("No devices yet.").waitFor();

  // Agents create devices through MCP with an access token for the signed-in user.
  const accessToken = await new SignJWT({
    iss: issuer, aud: "https://api.esphub.ai/mcp", sub: user, jti: randomUUID(),
    client_id: "test-public-client", scope: "devices:read devices:write",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ: "at+jwt" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const operate = async (name, args = {}) => {
    const response = await fetch(origin + "/backend/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(response.status, 200, name);
    const body = await response.text();
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    const { result } = JSON.parse(data ? data.slice(6) : body);
    assert.ok(!result.isError, name + ": " + result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };

  await operate("devices_create_virtual");
  const board = await operate("devices_create", {
    name: "Paper Color integration",
    board: "m5stack/paper-color",
  });
  await operate("devices_create", {
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
  for (const name of ["Paper Color integration", "Core2 integration"]) {
    const photo = card(name).locator("img");
    await photo.waitFor();
    const width = await photo.evaluate(async (img) => {
      await img.decode();
      return img.naturalWidth;
    });
    assert.ok(width > 0);
  }
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
        "devices_list",
        "devices_get",
        "bootloader_enter",
        "ota_install",
        "ota_resize_app",
        "devices_delete",
      ],
    ],
    ["Bind my ESP32", ["group/project", "devices_create", "devices_get"]],
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
    "PASS hosted authentication, physical device cards, live status refresh, MCP prompts, mobile layout",
  );
} finally {
  mcu?.close();
  await browser.close();
}
