import {
  deviceWifi,
  flashSetupKit,
  openUsb,
  waitForOnline,
  writeRegistration,
} from "./usb-setup.js";

export function setupPage({ main, boards, op, esc }) {
  if (!navigator.serial) {
    main.innerHTML =
      '<section class="app"><a class="crumb" href="/devices">← Devices</a><h1>Set up over USB</h1><p>Open this page in desktop Chrome or Edge to connect a USB board.</p></section>';
    return;
  }

  const options = Object.entries(boards)
    .map(
      ([id, board]) => `<option value="${esc(id)}">${esc(board.name)} (${esc(id)})</option>`,
    )
    .join("");
  main.innerHTML = `<section class="app"><a class="crumb" href="/devices">← Devices</a><h1>Set up over USB</h1>
    <div class="panel"><h2>Board</h2>
      <label>Board model<select class="field" id="setup-board"><option value="">Select board</option>${options}</select></label>
      <label>Device name<input class="field" id="setup-name" maxlength="64" required></label>
      <p id="setup-flash-help">Plug in a USB data cable and put the board in ROM download mode. Check the selected model carefully. First-time installation erases its flash, including existing apps and data.</p>
      <p><a id="setup-guide" target="_blank" rel="noopener">Board instructions</a></p>
      <label><input type="checkbox" id="setup-erase"> Erase this board and install ESPHub</label>
      <div class="actions"><button type="button" id="setup-flash">Flash over USB</button>
        <button type="button" id="setup-connect">Connect ESPHub Bootloader</button></div>
      <p>After flashing, keep the same board connected and restart it normally with BOOT released. Then connect its bootloader port.</p>
    </div>
    <form class="panel" id="setup-wifi" hidden>
      <h2>Wi-Fi</h2>
      <div class="actions"><button type="button" id="setup-scan">Scan nearby networks</button></div>
      <label>Scan results<select class="field" id="setup-networks"><option value="">Enter a network manually</option></select></label>
      <label>SSID<input class="field" name="ssid" required maxlength="32"></label>
      <label>Password<input class="field" name="password" type="password" maxlength="64" autocomplete="new-password"></label>
      <label><input type="checkbox" name="hidden"> Hidden network</label>
      <div class="actions"><button class="primary" type="submit">Connect and verify online</button></div>
    </form>
    <p id="setup-status" role="status" aria-live="polite"></p>
  </section>`;

  const $ = (id) => main.querySelector("#setup-" + id);
  const progress = (message) => {
    $("status").textContent = message;
  };
  const boardInput = $("board");
  const name = $("name");
  const wifi = $("wifi");
  let session;
  let expectedMac;
  let registration;
  let registered = false;
  let busy = false;

  function update() {
    const profile = boards[boardInput.value];
    const hasSetup = profile?.has_setup;
    $("guide").hidden = !profile;
    if (profile)
      $("guide").href =
        "https://github.com/okou-ai/esphub/blob/main/" +
        profile.directory +
        "/README.md";
    $("flash-help").hidden = !hasSetup;
    $("erase").parentElement.hidden = !hasSetup;
    $("flash").hidden = !hasSetup;
    $("flash").disabled =
      busy ||
      !$("erase").checked ||
      Boolean(expectedMac) ||
      Boolean(registration);
    boardInput.disabled = busy || Boolean(expectedMac) || Boolean(registration);
    name.disabled = busy || Boolean(registration);
    $("connect").disabled = busy || !profile;
    wifi.hidden = !registered;
    for (const control of wifi.elements)
      control.disabled = busy || !session || session.closed;
  }

  async function run(work) {
    if (busy) return;
    busy = true;
    update();
    try {
      await work();
    } catch (error) {
      progress(error.message);
    } finally {
      busy = false;
      update();
    }
  }

  $("erase").onchange = update;
  boardInput.onchange = () => {
    $("erase").checked = false;
    update();
  };
  $("flash").onclick = () =>
    run(async () => {
      const port = await navigator.serial.requestPort();
      expectedMac = await flashSetupKit(
        port,
        boardInput.value,
        boards[boardInput.value],
        progress,
      );
      progress(
        "Firmware written and verified. Restart the board normally, then connect its bootloader port.",
      );
    });
  $("connect").onclick = () =>
    run(async () => {
      if (!name.value.trim()) throw Error("Enter a name for the device.");
      const port = await navigator.serial.requestPort();
      await session?.close();
      session = await openUsb(port);
      const status = await deviceWifi(session, "wifi.status");
      if (
        status.protocol !== "esphub-usb-wifi-v1" ||
        !status.mac ||
        (expectedMac && status.mac !== expectedMac)
      ) {
        await session.close();
        throw Error(
          "Select the ESPHub Bootloader port for the same board you flashed.",
        );
      }
      expectedMac = status.mac;
      registration ??= await op("devices.create", {
        name: name.value.trim(),
        board: boardInput.value,
      });
      if (!registered) {
        const receipt = await writeRegistration(session, registration);
        if (receipt.ble_address)
          await op("devices.bind_ble_address", {
            device_id: registration.id,
            ble_address: receipt.ble_address,
          });
        registration = { id: registration.id };
        registered = true;
      }
      progress("Device registered. Scan for Wi-Fi or enter the network name.");
    });
  $("scan").onclick = () =>
    run(async () => {
      progress("Scanning Wi-Fi from the device…");
      const { ssids } = await deviceWifi(session, "wifi.scan");
      $("networks").replaceChildren(new Option("Enter a network manually", ""));
      for (const ssid of new Set(ssids.filter(Boolean)))
        $("networks").add(new Option(ssid, ssid));
      progress(
        ssids.length
          ? "Select a network or enter one manually."
          : "No networks found. Scan again or enter an SSID.",
      );
    });
  $("networks").onchange = (event) => {
    if (event.target.value) {
      wifi.elements.ssid.value = event.target.value;
      wifi.elements.hidden.checked = false;
    }
  };
  wifi.onsubmit = (event) => {
    event.preventDefault();
    const { ssid, password, hidden } = Object.fromEntries(new FormData(wifi));
    wifi.elements.password.value = "";
    run(async () => {
      progress("Connecting to Wi-Fi…");
      await deviceWifi(session, "wifi.join", {
        ssid,
        password,
        hidden: Boolean(hidden),
      });
      await waitForOnline(session, op, registration.id, ssid, progress);
      progress("Device is online.");
      await session.close();
      location.assign("/device/" + registration.id);
    });
  };
  window.addEventListener(
    "pagehide",
    () => {
      void session?.close();
    },
    { once: true },
  );
  update();
}
