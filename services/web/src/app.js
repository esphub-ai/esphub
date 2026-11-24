import boards from "../../../shared/boards.generated.json" with { type: "json" };
import { issuer, portal, application, mcpEndpoint } from "../../../shared/identity.js";
let clerk;
async function loadClerk() {
  const script = document.createElement("script");
  script.src = issuer + "/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
  script.crossOrigin = "anonymous";
  script.dataset.clerkPublishableKey =
    "pk_live_" + btoa(new URL(issuer).host + "$");
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(Error("Unable to load Clerk sign-in"));
    document.head.append(script);
  });
  clerk = window.Clerk;
  await clerk.load();
}
function hostedPage(path, returnTo) {
  const url = new URL(path, portal);
  url.searchParams.set("redirect_url", returnTo);
  return url.href;
}
const $ = (s) => document.querySelector(s),
  main = $("#main");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ],
  );
const boardName = Object.fromEntries(Object.entries(boards).map(([id, b]) => [id, b.name]));
const path = location.pathname.split("/").filter(Boolean),
  detail = path[0] === "device";
let user,
  device,
  tab = "Firmware",
  timer,
  view = 0;
const field = (key, label, type = "text", extra = "") =>
  "<label>" +
  label +
  '<input class="field" name="' +
  key +
  '" type="' +
  type +
  '" autocomplete="off" ' +
  extra +
  "></label>";
const button = (key, label, primary = false) =>
  '<button data-action="' +
  key +
  '" class="' +
  (primary ? "primary" : "") +
  '">' +
  label +
  "</button>";
const link = (url, label, primary = false) =>
  '<a href="' +
  url +
  '" class="button ' +
  (primary ? "primary" : "") +
  '">' +
  label +
  "</a>";
function notify(text) {
  $("#toast").textContent = text;
  $("#toast").classList.remove("hide");
  clearTimeout(timer);
  timer = setTimeout(() => $("#toast").classList.add("hide"), 5000);
}
async function api(path, data) {
  const jwt = await clerk?.session?.getToken();
  const r = await fetch("/backend" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(jwt ? { Authorization: "Bearer " + jwt } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const j = await r.json();
  if (!r.ok)
    throw Object.assign(Error(j.error || "Request failed"), {
      status: r.status,
    });
  return j;
}
async function op(name,args={}) {
  let value=await api("/operations/"+name,args);
  if(!value.command_id || name==="commands.get") return value;
  const command_id=value.command_id;
  notify("Command queued");
  const deadline =
    Date.now() + (name === "ota.install" ? 600000 : 90000);
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, 1000),
    );
    value = await api("/operations/commands.get", {
      device_id: args.device_id,
      command_id,
    });
    if (value.state === "succeeded")
      return { ...value.result, process_id: value.process_id };
    if (["failed", "expired", "unknown"].includes(value.state))
      throw Error(value.result?.error || "Command " + value.state);
  }
  throw Error("Command "+command_id+" is "+value.state+". Check commands.get for its receipt.");
}
function dialog(title, body, submit, fn) {
  const d = $("#dialog");
  if (d.open) d.close();
  d.innerHTML =
    "<form><h2>" +
    esc(title) +
    "</h2>" +
    body +
    '<div class="actions"><button type="button" id="close">Close</button>' +
    (submit ? '<button class="primary">' + esc(submit) + "</button>" : "") +
    "</div></form>";
  $("#close").onclick = () => d.close();
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.submitter;
    b.disabled = true;
    try {
      const v = Object.fromEntries(new FormData(e.target));
      d.close();
      await fn(v);
    } catch (err) {
      notify(err.message);
    } finally {
      b.disabled = false;
    }
  };
  d.showModal();
}
function docs(title, body) {
  main.innerHTML =
    '<section class="app docs"><a class="crumb" href="/">← Overview</a><div class="kicker">Platform reference</div><h1>' +
    title +
    "</h1>" +
    body +
    "</section>";
}
function softwareFields(device) {
  if (device.kind === "virtual") return [["Simulated firmware", device.info.fw.version]];
  const software = device.software;
  const app = software?.application;
  const fields = [["Launcher", (software?.bootloader_version || "Not reported") + (software?.bootloader_last_seen ? " (last seen)" : "")]];
  if (!app) return fields;
  fields.push(
    ["Runtime type", app.kind === "micropython" ? "MicroPython" : "Native program"],
    ["Runtime version", app.runtime_version || "Not reported"],
  );
  return fields;
}
function boardLabel(d) {
  return d.kind === "virtual" ? "Simulated ESP32" : boardName[d.board];
}
function row(d) {
  return (
    '<a class="device" href="/device/' +
    d.id +
    '"><span class="icon">▦</span><span class="desc"><b>' +
    esc(d.name) +
    "</b><small>" +
    esc(boardLabel(d)) +
    " · " +
    d.id.slice(0, 8) +
    "</small><small>" +
    (d.software?.application?.last_seen ? "Last seen app · " : "") +
    softwareFields(d).map(([label, value]) => label + " " + esc(value || "Not reported")).join(" · ") +
    '</small></span><span class="mini">' +
    (d.online ? "● Online" : "○ Offline") +
    "</span><span>↗</span></a>"
  );
}
const devicePrompt = `Connect to ${mcpEndpoint} with CIMD OAuth and the devices:read and devices:write scopes if needed. List my devices and ask what I want to do.

For a new board, identify it over USB. Ask me if the model is unclear, then call devices.create and follow its setup instructions.

For a program update, confirm the target and what I want it to do. Use an existing HTTPS download URL, upload a local firmware binary with ota.prepare_upload, or stage main.py with programs.publish. Call bootloader.enter, wait for Bootloader mode, then use ota.install with the matching kind and download URL. Check the install receipt and next boot’s identity before reporting success.`;
function devicePromptPanel() {
  return `<section class="mcp-setup" aria-labelledby="mcp-title"><h2 id="mcp-title">Use EspHub with your assistant</h2>
    <div class="mcp-grid"><div class="panel"><blockquote id="mcp-prompt">${esc(devicePrompt)}</blockquote>${button("copy-prompt", "Copy prompt")}</div></div></section>`;
}
async function fleet() {
  const ds = await op("devices.list");
  main.innerHTML =
    '<section class="app"><div class="kicker">Device workspace</div><div class="toolbar"><h1>Devices</h1><div class="flex">' +
    link("/account", "Account") +
    (ds.some((d) => d.kind === "virtual")
      ? ""
      : button("create-virtual", "Create virtual ESP32")) +
    button("add", "+ Add device", true) +
    '</div></div><div class="board"><div class="bar"><input class="field" style="max-width:320px" id="filter" aria-label="Filter devices" placeholder="Filter devices"><span class="tag">' +
    ds.length +
    ' REGISTERED</span></div><div id="rows"></div></div>' +
    devicePromptPanel() +
    "</section>";
  const show = () => {
    $("#rows").innerHTML =
      ds
        .filter((d) =>
          (d.name + " " + d.board + " " + d.id)
            .toLowerCase()
            .includes($("#filter").value.toLowerCase()),
        )
        .map(row)
        .join("") ||
      (ds.length
        ? '<div class="empty">No matching devices.</div>'
        : '<div class="empty">No devices found. Add a board or create a virtual ESP32 to get started.</div>');
  };
  $("#filter").oninput = show;
  show();
}
async function refresh() {
  const currentView = ++view;
  device = await op("devices.get", { device_id: path[1] });
  if (currentView !== view) return;
  const virtual = device.kind === "virtual";
  const tabs = virtual
    ? ["Firmware", "Settings"]
    : ["Wi-Fi", "Firmware", "Settings"];
  main.innerHTML =
    '<section class="app"><a class="crumb" href="/devices">← Devices</a><div class="toolbar"><div><div class="kicker">' +
    esc(boardLabel(device)) +
    "</div><h1>" +
    esc(device.name) +
    '</h1><span class="mono notice">' +
    device.id +
    '</span></div><span class="chip" id="connection">' +
    (device.online ? "● Online" : "○ Offline") +
    '</span></div><div class="tabs">' +
    tabs
      .map(
        (k) =>
          '<button data-tab="' +
          k +
          '" class="' +
          (tab === k ? "active" : "") +
          '">' +
          k +
          "</button>",
      )
      .join("") +
    '</div><div id="content"></div></section>';
  const area = $("#content");
  if (tab === "Wi-Fi") {
    area.innerHTML =
      '<div class="panel"><h3>Wi-Fi networks</h3><div class="flex">' +
      button("saved", "Saved networks") +
      button("scan", "Scan nearby") +
      button("wifi-add", "Add network") +
      button("forget", "Forget network") +
      '</div><pre id="out">Select an operation.</pre></div>';
    if (device.online) await action("saved");
  } else if (tab === "Firmware") {
    area.innerHTML =
      '<div class="panel"><h3>Firmware</h3><dl class="software">' +
      softwareFields(device).map(([label,value]) => "<dt>" + label + "</dt><dd>" + esc(value || "Not reported") + "</dd>").join("") +
      "</dl>" +
      (device.software?.application?.last_seen ? '<p class="notice">Application details are from its last reported boot.</p>' : "") +
      '<div class="flex">' +
      button("info", "Inspect device") +
      (virtual
        ? ""
        : button("enter", "Enter Bootloader mode") +
          button("install", "Install from URL") +
          button("bootloader", "Update Bootloader") +
          link("/setup?board=" + device.board, "Firmware downloads ↗")) +
      '</div><pre id="out" hidden></pre></div>';
    const app = device.software?.application;
    if (app?.kind === "micropython") {
      area.insertAdjacentHTML("beforeend", '<section class="panel"><h3>Last confirmed main.py install</h3><pre id="program">Loading…</pre></section>');
      const output = $("#program");
      try {
        const program = await op("programs.get", {device_id:device.id});
        if (currentView !== view) return;
        output.textContent = program.status === "installed"
          ? [program.transfer_id, program.sha256 && "SHA-256 " + program.sha256].filter(Boolean).join("\n")
          : "No confirmed cloud install.";
      } catch (error) {
        output.textContent = error.message;
      }
    }
  } else
    area.innerHTML =
      '<div class="panel"><h3>Device controls</h3><p class="notice">' +
      (virtual
        ? "Reboot starts a new simulated session."
        : "Reboot restarts the device. Reset clears the device token and saved Wi-Fi networks. Generate a new token to provision again over USB.") +
      '</p><div class="actions">' +
      button("reboot", "Reboot") +
      (virtual
        ? ""
        : button("reset", "Reset provisioning") +
          button("reissue", "Replace USB token")) +
      button("delete", "Delete device") +
      "</div></div>";
}
function credential(title, value) {
  dialog(
    title,
    '<p class="notice">Shown once. Store this credential securely.</p><pre>' +
      esc(value) +
      "</pre>",
    null,
  );
}
async function action(k) {
  if (k === "copy-prompt") {
    const source = $("#mcp-prompt");
    try {
      await navigator.clipboard.writeText(source.textContent);
      notify("Prompt copied");
    } catch {
      const selection = window.getSelection(),
        range = document.createRange();
      range.selectNodeContents(source);
      selection.removeAllRanges();
      selection.addRange(range);
      notify("Text selected. Use your system copy command.");
    }
    return;
  }
  if (k === "create-virtual") {
    const d = await op("devices.create_virtual");
    location.assign("/device/" + d.id);
    return;
  }
  if (k === "add") {
    dialog(
      "Register a device",
      field("name", "Device name", "text", 'required maxlength="64"') +
        '<label>Board<select class="field" name="board">' + Object.entries(boardName).map(([id, name]) => '<option value="' + esc(id) + '">' + esc(name) + '</option>').join('') + '</select></label>',
      "Register",
      async (a) => {
        const d = await op("devices.create", a);
        await fleet();
        credential(
          "USB provisioning",
          JSON.stringify({ hub: d.hub, token: d.token, ble_secret: d.ble_secret }),
        );
      },
    );
    return;
  }
  if (k === "logout") {
    await clerk.signOut({ redirectUrl: "https://esphub.ai/" });
    return;
  }
  const id = { device_id: device.id };
  if (k === "reissue") {
    dialog(
      "Replace USB token",
      "<p>This revokes the existing device credential. Write the new token and BLE bootstrap key over USB.</p>",
      "Replace",
      async () => {
        const result = await op("devices.reissue", id);
        credential("USB provisioning", JSON.stringify(result));
      },
    );
    return;
  }
  if (["saved", "scan", "info"].includes(k)) {
    const r = await op(
      { saved: "wifi.list", scan: "wifi.scan", info: "firmware.get" }[k],
      id,
    );
    if ($("#out")) {
      $("#out").hidden = false;
      $("#out").textContent = r.output ?? JSON.stringify(r, null, 2);
    }
    return;
  }
  if (["wifi-add", "forget"].includes(k)) {
    dialog(
      k === "forget" ? "Forget network" : "Save Wi-Fi network",
      field("ssid", "Network SSID", "text", "required") +
        (k === "forget"
          ? ""
          : field("password", "Password (optional)", "password")),
      "Apply",
      async (a) => {
        if (!a.password) delete a.password;
        await op(k === "forget" ? "wifi.remove" : "wifi.add", { ...id, ...a });
        await action("saved");
      },
    );
    return;
  }
  if (k === "enter") {
    dialog("Enter Bootloader mode", "<p>The running application pauses while the EspHub Bootloader handles updates.</p>", "Enter Bootloader mode", async () => {
      const result = await op("bootloader.enter", id);
      notify(result.mode === "bootloader" ? "Bootloader ready" : "Restarting into Bootloader mode");
      await refresh();
    });
    return;
  }
  if (k === "bootloader") {
    dialog(
      "Update Bootloader",
      "<p>Install the latest verified release for this specific board. The connected bootloader must report a matching board profile.</p>",
      "Install Bootloader",
      async () => {
        await op("ota.install", { ...id, kind: "bootloader" });
        tab = "Firmware";
        await refresh();
        notify("Bootloader image installed");
      },
    );
    return;
  }
  if (k === "install") {
    dialog(
      "Install from URL",
      '<label>Update target<select class="field" name="kind"><option value="python">Python Program (main.py)</option><option value="native">Native Program (.bin)</option><option value="micropython">MicroPython Runtime</option><option value="bootloader">Bootloader</option></select></label>' +
        field("url", "HTTPS artifact URL", "url", "required"),
      "Install",
      async (a) => {
        await op("ota.install", { ...id, ...a });
        notify("Install completed.");
        tab = "Firmware";
        await refresh();
      },
    );
    return;
  }
  if (["reset", "reboot", "delete"].includes(k)) {
    dialog(
      k === "delete"
        ? "Delete device?"
        : k === "reset"
          ? "Reset provisioning?"
          : "Reboot device?",
      "<p>" +
        {
          reset: "Saved Wi-Fi and device credentials will be cleared.",
          reboot:
            device.kind === "virtual"
              ? "Start a new simulated boot."
              : "The running program will restart.",
          delete: "The registration and device access will be revoked.",
        }[k] +
        "</p>",
      "Confirm",
      async () => {
        await op("devices." + k, id);
        if (k === "reboot" && device.kind === "virtual") {
          tab = "Firmware";
        }
        if (k === "delete") location.assign("/devices");
        else await refresh();
      },
    );
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b?.dataset.tab) {
    tab = b.dataset.tab;
    refresh().catch((err) => notify(err.message));
  }
  if (b?.dataset.action)
    action(b.dataset.action).catch((err) => notify(err.message));
});
async function explorer() {
  const [tools, devices] = await Promise.all([
    (await fetch("/tools.json")).json(),
    op("devices.list"),
  ]);
  docs(
    "Tool explorer",
    '<p class="lead">Run an operation on your own devices using your signed-in session.</p><div class="panel"><label>Tool<select class="field" id="tool">' +
      tools.map((t) => "<option>" + esc(t.name) + "</option>").join("") +
      '</select></label><p id="description" class="notice"></p><label>JSON arguments<textarea class="field mono" rows="6" id="args"></textarea></label><div class="actions"><button class="primary" id="run">Run tool</button></div><pre id="result">Ready.</pre></div>',
  );
  const example = {
    device_id: devices[0]?.id || "",
    process_id: devices[0]?.process_id || "",
    after: 0,
    request_id: crypto.randomUUID(),
    text: "help\n",
    source: 'print("Hello from EspHub")\n',
    name: "My board",
    board: Object.keys(boardName)[0],
    ssid: "",
    url: "",
    kind: "bootloader",
  };
  const select = () => {
    const t = tools.find((t) => t.name === $("#tool").value);
    $("#description").textContent = t.description;
    $("#args").value = JSON.stringify(
      Object.fromEntries(
        t.inputSchema.required.map((k) => [k, example[k] ?? ""]),
      ),
      null,
      2,
    );
  };
  $("#tool").onchange = select;
  select();
  $("#run").onclick = async () => {
    try {
      const name = $("#tool").value,
        args = JSON.parse($("#args").value),
        run = async () => {
          $("#result").textContent = JSON.stringify(
            await op(name, args),
            null,
            2,
          );
        };
      if (
        [
          "devices.delete",
          "devices.reissue",
          "devices.reset",
          "devices.reboot",
          "wifi.remove",
          "bootloader.enter",
          "bootloader.exit",
          "ota.install",
        ].includes(name)
      )
        dialog(
          "Run " + name + "?",
          "<p>This operation changes a live device or its registration.</p>",
          "Run tool",
          run,
        );
      else await run();
    } catch (e) {
      $("#result").textContent = e.message;
    }
  };
}
async function start() {
  if (path[0] === "setup") {
    const selectedBoard = new URLSearchParams(location.search).get("board");
    const profiles = Object.entries(boardName).filter(
      ([board]) =>
        !boards[board].preview &&
        (!Object.hasOwn(boardName, selectedBoard) || board === selectedBoard),
    );
    docs(
      "USB provisioning",
      '<div class="guide"><div class="panel"><h3>1. Identify and register</h3><p>Connect by USB, confirm the board model and call devices.create. Keep the returned token private.</p></div><div class="panel"><h3>2. Flash and connect</h3><p>Flash the first-time kit once to install EspHub with MicroPython. Use the matching board kit from GitHub Releases and follow INSTALL.txt. Write the registration token and BLE bootstrap key over USB. With the board in bootloader mode, run the Mac BLE provisioning tool and choose a Wi-Fi network or enter a hidden SSID.</p></div><div class="panel"><h3>3. Verify</h3><p>After Wi-Fi setup, call bootloader.exit or power-cycle the device, then check devices.get for the online MicroPython application. Stage the hello program with programs.publish. Enter Bootloader mode, install its URL with ota.install, then check the install receipt and confirm the new app boot.</p></div></div><pre>OKL-PROVISION {"hub":"api.esphub.ai","token":"&lt;token&gt;","ble_secret":"&lt;ble_secret&gt;"}</pre><p class="doccopy"><a href="https://github.com/okou-ai/esphub/tree/main/tools/ble-wifi">Mac BLE provisioning tool and instructions</a></p><h2>Board packages</h2><div class="flex">' +
        profiles
          .map(([board, name]) => {
            const base = "https://api.esphub.ai/releases/" + board + "/";
            return (
              '<div class="panel"><h3>' +
              esc(name) +
              '</h3><div class="flex">' +
              link(base + "setup", "First-time USB kit", true) +
              link(base + "setup-manifest", "Setup SHA-256 manifest") +
              '</div><details><summary>Firmware downloads</summary><div class="flex">' +
              link(base + "usb", "Bootloader-only USB kit") +
              link(base + "ota", "Bootloader OTA image") +
              link(base + "micropython", "MicroPython OTA image") +
              link(base + "manifest", "Bootloader manifest") +
              "</div></details></div>"
            );
          })
          .join("") +
        '</div><p class="notice" style="margin-top:16px">Browse all versions on <a href="https://github.com/okou-ai/esphub/releases">GitHub Releases</a>. First-time kits replace the partition table and app. Back up existing data before flashing. Use the kit labeled for your exact board.</p>',
    );
    return;
  }
  if (!["device", "devices", "account", "explorer"].includes(path[0])) {
    docs("Page not found", link("/", "Back to overview"));
    return;
  }
  await loadClerk();
  if (!clerk.session) {
    location.replace(hostedPage("/sign-in", location.href));
    return;
  }
  try {
    user = await api("/auth/me");
  } catch (e) {
    if (e.status === 401) {
      docs(
        "Session expired",
        link(hostedPage("/sign-in", location.href), "Sign in again"),
      );
      return;
    }
    throw e;
  }
  if (detail) await refresh();
  else if (path[0] === "explorer") await explorer();
  else if (path[0] === "account")
    docs(
      "Account",
      '<p class="lead">Signed in as ' +
        esc(
          clerk.user?.primaryEmailAddress?.emailAddress ||
            clerk.user?.username ||
            user.handle,
        ) +
        '</p><div class="actions">' +
        button("logout", "Sign out") +
        "</div>",
    );
  else await fleet();
}
start().catch((err) =>
  docs("Service unavailable", "<p>" + esc(err.message) + "</p>"),
);
