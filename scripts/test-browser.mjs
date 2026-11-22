import { chromium } from "playwright-core";
import WebSocket from "ws";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const origin = process.env.TEST_SITE_URL;
if (!origin || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw Error("Expected a local TEST_SITE_URL");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--no-proxy-server"],
});
let ws;
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(origin);
  await page.getByText("Open the console").click();
  const handle = "qa-" + randomUUID().slice(0, 8);
  await page.locator("[name=handle]").fill(handle);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("+ Add device").click();
  await page.locator("[name=name]").fill("Paper Color · integration");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  const token = JSON.parse(
    await page.locator("dialog pre").textContent(),
  ).token;
  await page.getByRole("button", { name: "Close", exact: true }).click();
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
  await page.locator(".device").first().click();
  await page.locator("#cmd").fill("hello from browser");
  await page.locator("#send button").click();
  await page
    .locator("#logs")
    .getByText(/serial echo: hello from browser/)
    .waitFor();
  await page.locator("#rx").filter({hasText: /^1$/}).waitFor();
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
  await page.locator("[name=handle]").fill(handle);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("+ Add device").waitFor();
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
  assert.deepEqual(errors, []);
  console.log(
    "PASS browser passkey registration and sign-in, live serial round trip, tool explorer, deletion, mobile navigation",
  );
} finally {
  ws?.close();
  await browser.close();
}
