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
const boardName = { "paper-color": "Paper Color", stopwatch: "StopWatch" };
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
function hero() {
  main.innerHTML =
    '<section class="hero"><div><div class="kicker">ESP32 device operations</div><h1>Your boards.<br><span class="accent">Within reach.</span></h1><p class="lead">Provision over USB, manage firmware and open a remote serial console from your browser or an MCP client.</p><div class="actions">' +
    link("/devices", "Open the console ↗", true) +
    '<span id="account-link">' +
    link(hostedPage("/sign-up", application + "/devices"), "Create account") +
    "</span>" +
    '</div></div><div class="art"><div class="halo"></div><img src="/esp32s3-e926c2315ec8.webp" alt="Espressif ESP32-S3 development board"><div class="meta"><span>HARDWARE PROFILE</span><span>ESPRESSIF</span></div><span class="caption">ESP32-S3 / DEVKITC-1</span><span class="cross">+</span></div></section><div class="strip"><a href="/setup">↳ USB provisioning</a><a href="/devices">↳ Device console</a><a href="/streams">↳ Boot-scoped UART</a><a href="/mcp">↳ MCP endpoint</a></div><section class="dash"><div class="kicker">Launcher firmware</div><h2>Supported devices</h2><div class="board">' +
    Object.entries(boardName)
      .map(
        ([k, n]) =>
          '<a class="device" href="/setup?board=' +
          k +
          '"><span class="icon">▦</span><span class="desc"><b>' +
          n +
          "</b><small>ESP32-S3 · 16 MB flash</small></span><span>USB setup ↗</span></a>",
      )
      .join("") +
    "</div></section>";
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
const setupPrompt = `Connect esphub at ${mcpEndpoint} using HTTP and CIMD OAuth. Request devices:read and devices:write, then list my devices.`;
const workflows = [
  {
    key: "initialize",
    title: "Initialize a device",
    detail: "Plug the board into your computer by USB. Your assistant will flash it, help you choose Wi-Fi and verify the display.",
    prompt: "Identify my USB board. Ask me if the model is unclear. Call devices.create and follow its setup prompt.",
  },
  {
    key: "update",
    title: "Update a program",
    detail: "Once your board is online, send a new MicroPython program over Wi-Fi.",
    prompt: "Ask what I want to build and which board to use if unclear. Deploy it with programs.install and report the verified result.",
  },
];
function workflowCards() {
  return `<section class="mcp-setup" aria-labelledby="workflows-title"><h2 id="workflows-title">Device workflows</h2><div class="mcp-grid">${workflows.map(({ key, title, detail, prompt }) =>
    `<article class="panel"><h3>${title}</h3><p>${detail}</p><blockquote id="prompt-${key}">${esc(prompt)}</blockquote>${button("copy-" + key, "Copy prompt")}</article>`
  ).join("")}</div></section>`;
}
const mcpClients = {
  codex: {
    instruction: "Use a Codex version with CIMD support. Add the server and follow the browser prompt. If you already added it, run codex mcp login esphub --oauth-client-registration cimd.",
    config: `codex mcp add esphub --url ${mcpEndpoint}`,
  },
  claude: {
    instruction: "Merge this entry into your project’s .mcp.json file. In Claude Code, open /mcp, select esphub, and authenticate.",
    config: JSON.stringify(
      {
        mcpServers: {
          esphub: {
            type: "http",
            url: mcpEndpoint,
          },
        },
      },
      null,
      2,
    ),
  },
};
function mcpSetup() {
  return `<section class="mcp-setup" aria-labelledby="mcp-title">
    <div class="toolbar"><h2 id="mcp-title">Connect an MCP client</h2></div>
    <p>Sign in with your ESP Hub account to grant device access. <a href="/mcp">MCP reference ↗</a></p>
    <div class="mcp-grid">
      <div class="panel"><div class="toolbar"><h3>Client configuration</h3><select id="mcp-client" aria-label="MCP client"><option value="codex">Codex</option><option value="claude">Claude Code</option></select></div>
        <p id="mcp-instruction"></p><pre id="mcp-config"></pre>${button("copy-config", "Copy configuration")}</div>
      <div class="panel"><h3>Set up with your assistant</h3><p>Paste this prompt into the assistant that configures your client.</p>
        <blockquote id="mcp-prompt">${esc(setupPrompt)}</blockquote>${button("copy-prompt", "Copy prompt")}</div>
    </div></section>`;
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
    mcpSetup() + workflowCards() +
    "</section>";
  const select = $("#mcp-client");
  function showConfig() {
    const client = mcpClients[select.value];
    $("#mcp-instruction").textContent = client.instruction;
    $("#mcp-config").textContent = client.config;
  }
  select.onchange = showConfig;
  showConfig();
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
    const setState = (active) => {
      $("#cmd").disabled = !active;
      $("#send button").disabled = !active;
      $("#state").textContent = active ? "Connected" : "Read-only session";
    };
    setState(device.online && session === device.process_id);
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
          setState(ds.online && ds.process_id === session);
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
      button("install", "Install application") +
      button("launcher", "Update launcher") +
      link("/setup?board=" + device.board, "Launcher downloads ↗") +
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
  const copyTargets = {
    "copy-config": "#mcp-config",
    "copy-prompt": "#mcp-prompt",
    "copy-initialize": "#prompt-initialize",
    "copy-update": "#prompt-update",
  };
  if (Object.hasOwn(copyTargets, k)) {
    const source = $(copyTargets[k]);
    try {
      await navigator.clipboard.writeText(source.textContent);
      notify(k === "copy-config" ? "Configuration copied" : "Prompt copied");
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
        '<label>Board<select class="field" name="board"><option value="paper-color">Paper Color</option><option value="stopwatch">StopWatch</option></select></label>',
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
      "Install application firmware",
      field("url", "HTTPS image URL", "url", "required") +
        field("sha256", "SHA-256", "text", 'required minlength="64"') +
        field("version", "Application version", "text", "required"),
      "Install",
      async (a) => {
        await op("firmware.install", { ...id, ...a });
        notify("Install accepted. Follow progress in Serial.");
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
    source: 'print("Hello from ESP Hub")\n',
    name: "My board",
    board: "paper-color",
    ssid: "",
    url: "",
    version: "",
    sha256: "",
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
          "firmware.install",
          "programs.install",
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
  if (!path.length) {
    if (location.hostname === "app.esphub.ai") {
      location.replace("/devices");
      return;
    }
    hero();
    // Keep public content available while Clerk checks the shared domain session.
    try {
      await loadClerk();
      if (clerk.session) {
        await api("/auth/me");
        $("#account-link").innerHTML = link(
          application + "/account",
          "My account",
        );
      }
    } catch (error) {
      console.warn("Unable to check the ESP Hub session", error.name);
    }
    return;
  }
  if (path[0] === "mcp") {
    const ref = await (await fetch("/tools.json")).json();
    docs(
      "MCP reference",
      '<p class="lead">Connect your MCP client to ESP Hub with OAuth. Clients request read and write access by default. Read access covers device details, saved Wi-Fi networks, firmware information and serial output. Write access covers device management, Wi-Fi scans and changes, firmware and program installation, and serial input.</p><pre>https://api.esphub.ai/mcp</pre>' +
        link("/devices", "Client setup →") +
        " " +
        link("/explorer", "Open tool explorer ↗", true) +
        workflowCards() + "<h2>Tools</h2><table><tr><th>Name</th><th>Capability</th></tr>" +
        ref
          .map(
            (t) =>
              "<tr><td>" +
              esc(t.name) +
              "</td><td>" +
              esc(t.description) +
              "</td></tr>",
          )
          .join("") +
        "</table>",
    );
    return;
  }
  if (path[0] === "streams") {
    docs(
      "UART streams",
      '<p class="lead">Every boot has its own input and output streams. Record numbers start at one.</p><pre>devices/{DEVICE-UUID}/{PROCESS-ID}/uart/rx\ndevices/{DEVICE-UUID}/{PROCESS-ID}/uart/tx</pre><h2>RX · device stdin</h2><p class="doccopy">Web and MCP queue input against an active boot. The board polls after its local cursor. Reconnects resume that cursor; rebooting creates a different process. Reuse the request ID to safely retry an enqueue.</p><h2>TX · device stdout</h2><p class="doccopy">The board sends numbered logs. Each client polls after its last delivered sequence. Archived boots are read-only. R2 stores bounded record pages and a committed cursor manifest for each direction.</p>',
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
      '<div class="guide"><div class="panel"><h3>1. Identify and register</h3><p>Connect by USB, confirm the board model and call devices.create. Keep the returned token private.</p></div><div class="panel"><h3>2. Flash and connect</h3><p>Verify the first-time kit against its SHA-256 manifest. Follow INSTALL.txt. In the USB console, run <code>wifi scan</code>, choose a network or enter a hidden SSID, then send the provisioning line below. For a hidden network set <code>hidden</code> to true.</p></div><div class="panel"><h3>3. Verify</h3><p>Wait for OKL-PROVISION-OK and check devices.get for the online MicroPython application. Install the supplied hello program and check its serial output.</p></div></div><pre>OKL-PROVISION {"hub":"api.esphub.ai","token":"&lt;token&gt;","wifi":{"ssid":"&lt;ssid&gt;","pass":"&lt;password&gt;","hidden":false}}</pre><h2>Board packages</h2><div class="flex">' +
        profiles
          .map(([board, name]) => {
            const base = "https://api.esphub.ai/releases/" + board + "/";
            return (
              '<div class="panel"><h3>' +
              esc(name) +
              '</h3><div class="flex">' +
              link(base + "setup", "First-time USB kit", true) +
              link(base + "setup-manifest", "Setup SHA-256 manifest") +
              link(base + "usb", "Launcher-only USB kit") +
              link(base + "ota", "Launcher OTA image") +
              link(base + "manifest", "Launcher manifest") +
              "</div></div>"
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
