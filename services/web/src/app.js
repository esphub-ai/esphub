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
  tab = "Serial",
  session = "",
  cursor = 0,
  poll = null,
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
const op = (name, args = {}) => api("/operations/" + name, args);
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
function row(d) {
  return (
    '<a class="device" href="/device/' +
    d.id +
    '"><span class="icon">▦</span><span class="desc"><b>' +
    esc(d.name) +
    "</b><small>" +
    esc(boardName[d.board]) +
    " · " +
    d.id.slice(0, 8) +
    '</small></span><span class="tag">' +
    esc(d.info?.fw?.version || "No report") +
    '</span><span class="mini">' +
    (d.online ? "● Online" : "○ Offline") +
    "</span><span>↗</span></a>"
  );
}
const devicePrompt = `Connect to ${mcpEndpoint} with CIMD OAuth and the devices:read and devices:write scopes if needed. List my devices and ask what I want to do.

For a new board, identify it over USB. Ask me if the model is unclear, then call devices.create and follow its setup instructions.

For a program update, confirm the target and what I want it to do. Use an existing HTTPS download URL, upload a local file with ota.prepare_upload, or stage generated main.py with programs.publish. Call launcher.enter, wait for launcher mode, then use ota.install with the matching kind and download URL. Check the next boot’s output before reporting success.`;
function devicePromptPanel() {
  return `<section class="mcp-setup" aria-labelledby="mcp-title"><h2 id="mcp-title">Use EspHub with your assistant</h2>
    <div class="mcp-grid"><div class="panel"><blockquote id="mcp-prompt">${esc(devicePrompt)}</blockquote>${button("copy-prompt", "Copy prompt")}</div></div></section>`;
}
async function fleet() {
  const ds = await op("devices.list");
  main.innerHTML =
    '<section class="app"><div class="kicker">Device workspace</div><div class="toolbar"><h1>Devices</h1><div class="flex">' +
    link("/account", "Account") +
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
      '<div class="empty">No devices found. Register your board to get started.</div>';
  };
  $("#filter").oninput = show;
  show();
}
async function refresh() {
  const currentView = ++view;
  clearTimeout(poll);
  device = await op("devices.get", { device_id: path[1] });
  if (currentView !== view) return;
  main.innerHTML =
    '<section class="app"><a class="crumb" href="/devices">← Devices</a><div class="toolbar"><div><div class="kicker">' +
    esc(boardName[device.board]) +
    "</div><h1>" +
    esc(device.name) +
    '</h1><span class="mono notice">' +
    device.id +
    '</span></div><span class="chip" id="connection">' +
    (device.online ? "● Online" : "○ Offline") +
    '</span></div><div class="tabs">' +
    ["Serial", "Wi-Fi", "Firmware", "Settings"]
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
  if (tab === "Serial") {
    const sessions = await op("uart.sessions", { device_id: device.id });
    if (currentView !== view) return;
    if (!sessions.length) {
      area.innerHTML =
        '<div class="panel"><h3>No boot sessions yet</h3><p>Connect the board over USB and complete provisioning.</p><div class="actions">' +
        link("/setup?board=" + device.board, "USB setup →") +
        "</div></div>";
      const awaitFirstBoot = async () => {
        try {
          const boots = await op("uart.sessions", { device_id: device.id });
          if (currentView === view && boots.length) await refresh();
        } catch (err) {
          if (currentView === view) notify(err.message);
        } finally {
          if (currentView === view) poll = setTimeout(awaitFirstBoot, 2500);
        }
      };
      poll = setTimeout(awaitFirstBoot, 2500);
      return;
    }
    const selected =
      sessions.find((s) => s.process_id === session) || sessions[0];
    session = selected.process_id;
    cursor = 0;
    area.innerHTML =
      '<div class="columns"><div class="console"><div class="termhead"><span>◉ Serial console</span><span id="state"></span></div><div id="logs" class="logs"></div><form id="send" class="inputrow"><span>›</span><input id="cmd" class="cmd" aria-label="Serial command" placeholder="Enter a command" maxlength="1000"><button>Send ↵</button></form></div><div class="panel"><h3>Boot session</h3><select aria-label="Process ID" id="pid" class="field">' +
      sessions
        .map(
          (s) =>
            '<option value="' +
            s.process_id +
            '" ' +
            (s.process_id === session ? "selected" : "") +
            ">" +
            esc(s.process_id.slice(0, 10) + " · " + s.started_at) +
            "</option>",
        )
        .join("") +
      '</select><div class="kv cursor-value">Device RX cursor <b id="rx">' +
      selected.rx_cursor +
      '</b></div><div class="kv cursor-value">Browser TX cursor <b id="tx">0</b></div><a class="crumb" href="/streams">Stream protocol ↗</a></div></div>';
    const setState = (d) => {
      const active = d.online && session === d.process_id && d.serial_input !== false;
      $("#cmd").disabled = !active;
      $("#send button").disabled = !active;
      $("#state").textContent = active ? "Connected" : "Read-only session";
    };
    setState(device);
    $("#pid").onchange = (e) => {
      session = e.target.value;
      refresh().catch((err) => notify(err.message));
    };
    $("#send").onsubmit = async (e) => {
      e.preventDefault();
      const input = $("#cmd"),
        text = input.value;
      if (!text.trim()) return;
      try {
        await op("uart.write", {
          device_id: device.id,
          process_id: session,
          text: text + "\n",
          request_id: crypto.randomUUID(),
        });
        input.value = "";
        notify("Input queued");
      } catch (err) {
        notify(err.message);
      }
    };
    let ticks = 0;
    const tail = async () => {
      try {
        const page = await op("uart.read", {
          device_id: device.id,
          process_id: session,
          after: cursor,
        });
        if (currentView !== view) return;
        const logs = $("#logs"),
          bottom = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 30;
        for (const r of page.records) {
          const el = document.createElement("div");
          el.textContent = r.at.slice(11, 19) + "  " + r.text;
          logs.append(el);
        }
        while (logs.children.length > 1500) logs.firstChild.remove();
        if (bottom) logs.scrollTop = logs.scrollHeight;
        cursor = page.cursor;
        $("#tx").textContent = cursor;
        if (++ticks % 4 === 0) {
          const [ds, ss] = await Promise.all([
            op("devices.get", { device_id: device.id }),
            op("uart.sessions", { device_id: device.id }),
          ]);
          if (currentView !== view) return;
          $("#rx").textContent =
            ss.find((s) => s.process_id === session)?.rx_cursor ?? 0;
          $("#connection").textContent = ds.online ? "● Online" : "○ Offline";
          setState(ds);
          if (ss.length !== sessions.length) {
            await refresh();
            return;
          }
        }
      } catch (err) {
        if (currentView === view) $("#state").textContent = err.message;
      } finally {
        if (currentView === view) poll = setTimeout(tail, 1600);
      }
    };
    await tail();
  } else if (tab === "Wi-Fi") {
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
      '<div class="panel"><h3>Firmware</h3><pre>' +
      esc(
        JSON.stringify(
          device.info?.fw ?? { status: "Awaiting first connection" },
          null,
          2,
        ),
      ) +
      '</pre><div class="flex">' +
      button("info", "Inspect device") +
      button("enter", "Enter launcher mode") +
      button("install", "Install from URL") +
      (device.info?.role === "launcher" && !device.info?.image_profile ? button("launcher", "Upgrade legacy launcher") : "") +
      link("/setup?board=" + device.board, "Firmware downloads ↗") +
      '</div><pre id="out" hidden></pre></div>';
  } else
    area.innerHTML =
      '<div class="panel"><h3>Device controls</h3><p class="notice">Reboot opens a new serial session. Reset clears the device token and saved Wi-Fi networks. Generate a new token to provision again over USB.</p><div class="actions">' +
      button("reboot", "Reboot") +
      button("reset", "Reset provisioning") +
      button("reissue", "Replace USB token") +
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
          JSON.stringify({ hub: d.hub, token: d.token }, null, 2),
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
      "<p>This revokes the existing device credential. Write the new token over USB.</p>",
      "Replace",
      async () =>
        credential("USB token", (await op("devices.reissue", id)).token),
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
    dialog("Enter launcher mode", "<p>The running application pauses while the launcher handles updates.</p>", "Enter launcher mode", async () => {
      const result = await op("launcher.enter", id);
      notify(result.mode === "launcher" ? "Launcher ready" : "Restarting into launcher mode");
      await refresh();
    });
    return;
  }
  if (k === "launcher") {
    dialog(
      "Update launcher",
      "<p>Install the latest verified release for this specific board. The connected launcher must report a matching board profile.</p>",
      "Install launcher",
      async () => {
        await op("launcher.install", id);
        tab = "Serial";
        await refresh();
        notify("Launcher update accepted");
      },
    );
    return;
  }
  if (k === "install") {
    dialog(
      "Install from URL",
      '<label>Update target<select class="field" name="kind"><option value="python">Python program (main.py)</option><option value="micropython">MicroPython runtime</option><option value="launcher">Launcher</option></select></label>' +
        field("url", "HTTPS artifact URL", "url", "required"),
      "Install",
      async (a) => {
        const receipt = await op("ota.install", { ...id, ...a });
        session = receipt.process_id;
        notify("Download accepted. Follow progress in Serial.");
        tab = "Serial";
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
          reboot: "The running program will restart.",
          delete: "The registration and device access will be revoked.",
        }[k] +
        "</p>",
      "Confirm",
      async () => {
        await op("devices." + k, id);
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
    kind: "python",
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
          "launcher.enter",
          "ota.install",
          "launcher.install",
          "uart.write",
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
  if (path[0] === "streams") {
    docs(
      "UART streams",
      '<p class="lead">Every boot has its own input and output streams. Record numbers start at one.</p><pre>devices/{DEVICE-UUID}/{PROCESS-ID}/uart/rx\ndevices/{DEVICE-UUID}/{PROCESS-ID}/uart/tx</pre><h2>RX · device stdin</h2><p class="doccopy">Web and MCP queue input against an active boot. The launcher handles command lines. MicroPython programs can read application messages with okou.read_input(). The board polls after its local cursor. Reconnects resume that cursor; rebooting creates a different process. Reuse the request ID to safely retry an enqueue.</p><h2>TX · device stdout</h2><p class="doccopy">The board sends numbered logs. Each client polls after its last delivered sequence. Archived boots are read-only. R2 stores bounded record pages and a committed cursor manifest for each direction.</p>',
    );
    return;
  }
  if (path[0] === "setup") {
    const selectedBoard = new URLSearchParams(location.search).get("board");
    const profiles = Object.entries(boardName).filter(
      ([board]) =>
        !Object.hasOwn(boardName, selectedBoard) || board === selectedBoard,
    );
    docs(
      "USB provisioning",
      '<div class="guide"><div class="panel"><h3>1. Identify and register</h3><p>Connect by USB, confirm the board model and call devices.create. Keep the returned token private.</p></div><div class="panel"><h3>2. Flash and connect</h3><p>Flash the first-time kit once to install EspHub with MicroPython. Use the matching board kit from GitHub Releases and follow INSTALL.txt. In the USB console, run <code>wifi scan</code>, choose a network or enter a hidden SSID, then send the provisioning line below. For a hidden network set <code>hidden</code> to true.</p></div><div class="panel"><h3>3. Verify</h3><p>Wait for OKL-PROVISION-OK and check devices.get for the online MicroPython application. Stage the hello program with programs.publish. Enter launcher mode, install its URL with ota.install, then check the new boot for the hello message.</p></div></div><pre>OKL-PROVISION {"hub":"api.esphub.ai","token":"&lt;token&gt;","wifi":{"ssid":"&lt;ssid&gt;","pass":"&lt;password&gt;","hidden":false}}</pre><h2>Board packages</h2><div class="flex">' +
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
              link(base + "usb", "Launcher-only USB kit") +
              link(base + "ota", "Launcher OTA image") +
              link(base + "micropython", "MicroPython OTA image") +
              link(base + "manifest", "Launcher manifest") +
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
