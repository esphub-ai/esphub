import { chromium } from "playwright-core";
import WebSocket from "ws";
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
let ws;
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
  assert.equal(
    new URL(
      await page
        .getByRole("link", { name: "Create account" })
        .getAttribute("href"),
    ).pathname,
    "/sign-up",
  );
  await page.getByText("Open the console").click();
  await page.waitForURL("https://accounts.esphub.ai/sign-in?**");
  assert.equal(
    new URL(page.url()).searchParams.get("redirect_url"),
    origin + "/devices",
  );
  signedIn = true;
  await page.goto(origin);
  await page.getByRole("link", { name: "My account" }).waitFor();
  await page.goto(origin + "/devices");
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const setup = page.getByRole("region", { name: "Connect an MCP client" });
  await setup.getByRole("button", { name: "Copy configuration" }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "codex mcp add esphub --url https://api.esphub.ai/mcp\ncodex mcp login esphub",
  );
  await setup.getByLabel("MCP client").selectOption("claude");
  await setup.getByRole("button", { name: "Copy configuration" }).click();
  const entry = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  ).mcpServers.esphub;
  assert.deepEqual(entry, {
    type: "http",
    url: "https://api.esphub.ai/mcp",
  });
  await setup.getByRole("button", { name: "Copy prompt" }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    await setup.locator("blockquote").textContent(),
  );
  assert.equal(
    await setup.getByRole("button", { name: /issue.*key/i }).count(),
    0,
  );
  assert.match(await setup.locator("blockquote").textContent(), /OAuth/);
  await setup.getByLabel("MCP client").selectOption("codex");
  if (process.env.QA_MCP_SCREENSHOT)
    await page.screenshot({
      path: process.env.QA_MCP_SCREENSHOT,
      fullPage: true,
    });
  await page.getByText("+ Add device").click();
  await page.locator("[name=name]").fill("Paper Color · integration");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  const token = JSON.parse(
    await page.locator("dialog pre").textContent(),
  ).token;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".device").first().click();
  await page.getByText("No boot sessions yet").waitFor();
  const url = new URL("/backend/api/device/connect", origin);
  url.protocol = "ws:";
  ws = new WebSocket(url, { headers: { Authorization: "Bearer " + token } });
  await new Promise((ok, no) => {
    ws.once("open", ok);
    ws.once("error", no);
  });
  const pid = randomUUID();
  const send = (o) => ws.send(JSON.stringify(o));
  const ack = new Promise((ok) => ws.once("message", ok));
  send({
    t: "hello",
    boot_id: pid,
    board: "paper-color",
    chip: "esp32s3",
    fw: { name: "launcher", version: "test" },
    role: "launcher",
  });
  await ack;
  let rx = 0,
    seq = 0;
  ws.on("message", (buf) => {
    const m = JSON.parse(buf);
    if (m.t === "uart.input" && m.seq > rx) {
      rx = m.seq;
      send({
        t: "log",
        seq: ++seq,
        lines: [[100, "I", "serial echo: " + m.text.trim()]],
      });
    }
  });
  const poll = setInterval(() => {
    if (ws.readyState === 1) send({ t: "uart.poll", after: rx });
  }, 200);
  poll.unref();
  await page.locator("#cmd").fill("hello from browser");
  await page.locator("#send button").click();
  await page
    .locator("#logs")
    .getByText(/serial echo: hello from browser/)
    .waitFor();
  await page.locator("#rx").filter({ hasText: /^1$/ }).waitFor();
  if (process.env.QA_SCREENSHOT)
    await page.screenshot({ path: process.env.QA_SCREENSHOT });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete device", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText(/No devices found/).waitFor();
  clearInterval(poll);
  await page.goto(origin + "/explorer");
  await page.getByRole("button", { name: "Run tool" }).click();
  await page.locator("#result").filter({ hasText: "[]" }).waitFor();
  await page.goto(origin + "/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(origin + "/signed-out");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ["/", "/devices", "/setup", "/streams", "/mcp"]) {
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
      .getByRole("link", { name: "USB installation kit" })
      .getAttribute("href"),
    "https://api.esphub.ai/releases/stopwatch/usb",
  );
  assert.equal(
    await page.getByRole("link", { name: "Launcher OTA image" }).count(),
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS hosted sign-in and sign-up routing, signed session verification, live serial round trip, tool explorer, deletion, mobile navigation",
  );
} finally {
  ws?.close();
  await browser.close();
}
