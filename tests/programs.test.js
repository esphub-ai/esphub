import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { readFileSync, statSync } from "node:fs";
import boards from "../shared/boards.generated.json" with { type: "json" };
import { updateSources } from "../services/api/src/update-sources.js";
import { provisioning } from "../services/api/src/provisioning.js";
import { operate, validate } from "../services/api/src/operations.js";

test("each board links to the actual source, build recipes and provisioning example", () => {
  const { repository, ref } = JSON.parse(
    readFileSync("firmware/pyrt/upstream.json"),
  );
  function localPath(url, view) {
    const prefix = "https://github.com/okou-ai/esphub/" + view + "/main/";
    assert.ok(url.startsWith(prefix), url);
    return url.slice(prefix.length);
  }
  for (const board of Object.keys(boards)) {
    if (boards[board].preview) continue;
    const { sources, custom_build_guide_url, firmware_update } =
      updateSources(board);
    assert.equal(
      firmware_update.bootloader.download_url,
      `https://api.esphub.ai/releases/${board}/ota`,
    );
    assert.equal(
      firmware_update.runtime.download_url,
      `https://api.esphub.ai/releases/${board}/micropython`,
    );
    assert.ok(
      readFileSync(
        "firmware/components/okou_agent/include/okou_agent.h",
        "utf8",
      ).includes(
        `#define OKOU_SDK_VERSION "${firmware_update.program.sdk_version}"`,
      ),
    );
    const variant = localPath(sources.bootloader.variant_directory_url, "tree");
    assert.equal(variant, "firmware/bootloader/" + boards[board].bootloader);
    assert.ok(statSync(variant + "/CMakeLists.txt").isFile());
    for (const [kind, layer] of Object.entries(sources)) {
      assert.ok(statSync(localPath(layer.directory_url, "tree")).isDirectory());
      if (kind === "python") {
        assert.equal(
          readFileSync(localPath(layer.starter_file_url, "blob"), "utf8"),
          provisioning(board).verification_source,
        );
        continue;
      }
      const expected = `${boards[board].directory}/${kind === "bootloader" ? "layout" : kind}`;
      const buildAction =
        kind === "bootloader"
          ? "scripts/build-bootloader.sh"
          : expected + "/action.yml";
      assert.equal(localPath(layer.board_directory_url, "tree"), expected);
      assert.equal(localPath(layer.build_action_url, "blob"), buildAction);
      assert.ok(statSync(buildAction).isFile());
    }
    assert.equal(
      sources.micropython.upstream_directory_url,
      `https://github.com/${repository}/tree/${ref}`,
    );
    assert.equal(
      localPath(custom_build_guide_url, "blob"),
      "README.md#build-your-own-update",
    );
  }
});

test("ESP-Mosaico registers with a native example and no MicroPython download", async () => {
  const board = "espressif/esp-mosaico";
  const sql = async (strings, ...args) => {
    assert.match(strings.join("?"), /INSERT INTO esphub.devices/);
    assert.equal(args[2], board);
    assert.match(args[3], /^[a-f0-9]{64}$/);
    return [
      { id: "test-device", name: "ESP-Mosaico", board, kind: "physical" },
    ];
  };
  const result = await operate({ sql }, "owner", "devices.create", {
    name: "ESP-Mosaico",
    board,
  });
  assert.equal(result.board, board);
  assert.match(result.token, /^okl_dev_/);
  assert.match(result.ble_secret, /^[a-f0-9]{64}$/);
  assert.match(result.prompt, /runtime type native/);
  assert.match(
    result.sources.bootloader.variant_directory_url,
    /esp32s31-16mb-usb-cdc$/,
  );
  assert.match(result.setup_manifest, /esp-mosaico\/setup-manifest$/);
  assert.equal(
    result.firmware_update.bootloader.setup_manifest_url,
    result.setup_manifest,
  );
  assert.equal(result.verification_source, undefined);
  assert.match(
    result.firmware_update.program.download_url,
    /esp-mosaico\/native$/,
  );
  assert.match(
    result.sources.native.build_action_url,
    /esp-mosaico\/native\/action.yml$/,
  );
  assert.equal(result.firmware_update.runtime, undefined);
  assert.equal(result.sources.micropython, undefined);
});

test("Paper Color and StopWatch verification programs draw the measured status and greeting in a single frame", () => {
  for (const [board, model] of [
    ["m5stack/stopwatch", "Stopwatch"],
    ["m5stack/paper-color", "Paper Color"],
  ]) {
    const { verification_source } = provisioning(board);
    const stub = `import sys, json
from types import SimpleNamespace
from unittest.mock import MagicMock
lcd = MagicMock()
canvas = lcd.newCanvas.return_value
lcd.width.return_value, lcd.height.return_value = 400, 400
canvas.textWidth.side_effect = len
sys.modules['M5'] = SimpleNamespace(Lcd=lcd, Power=SimpleNamespace(getBatteryLevel=lambda: 73), Widgets=MagicMock())
sys.modules['okou'] = SimpleNamespace(wifi_rssi=lambda: -51)
exec(sys.stdin.read(), {})
canvas.push.assert_called_once_with(0, 0)
print(json.dumps([c.args for c in canvas.drawString.call_args_list]))
`;
    const output = execFileSync("python3", ["-I", "-c", stub], {
      input: verification_source,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assert.equal(output[0], "ESP Hub hello drawn: " + board);
    const lines = JSON.parse(output[1]);
    assert.deepEqual(
      lines.map(([text]) => text),
      [
        "Wi-Fi -51 dBm   Battery 73%",
        "Hello, M5Stack " + model,
        "Powered by ESPHub.ai",
      ],
    );
    assert.ok(lines[0][2] < lines[1][2] && lines[1][2] < lines[2][2]);
  }
});

test("Cardputer-Adv greeting checks the board and displays an official keyboard event", () => {
  const stub = `import sys
from types import SimpleNamespace
from unittest.mock import MagicMock
lcd = MagicMock()
lcd.width.return_value, lcd.height.return_value = 240, 135
m5 = MagicMock(Lcd=lcd)
m5.getBoard.return_value = m5.BOARD.M5CardputerADV
sys.modules['M5'] = m5
sys.modules['okou'] = SimpleNamespace(wifi_rssi=lambda: -56)
keyboard = MagicMock()
keyboard.is_pressed.return_value = True
keyboard.get_key.return_value = ord('x')
sys.modules['hardware'] = SimpleNamespace(MatrixKeyboard=lambda: keyboard)
class End(Exception): pass
def sleep_ms(delay): raise End()
sys.modules['time'] = SimpleNamespace(sleep_ms=sleep_ms)
try: exec(sys.stdin.read(), {})
except End: pass
lcd.drawString.assert_any_call('Key: x', 8, 98)
`;
  const output = execFileSync("python3", ["-I", "-c", stub], {
    input: provisioning("m5stack/cardputer-adv").verification_source,
    encoding: "utf8",
  });
  assert.match(output, /ESP Hub hello drawn: m5stack\/cardputer-adv 240 135/);
  assert.match(output, /Keyboard event: 120/);
});

test("publishing bounds UTF-8 byte size and OTA accepts the supported HTTPS targets", () => {
  const device_id = crypto.randomUUID();
  assert.throws(
    () =>
      validate("programs.publish", { device_id, source: "é".repeat(16385) }),
    /Invalid source/,
  );
  for (const kind of ["bootloader", "micropython", "native", "python"])
    validate("ota.install", {
      device_id,
      kind,
      url: "https://example.com/artifact",
    });
  assert.throws(() => validate("ota.install", { device_id, kind: "native" }), /Artifact URL required/);
  for (const url of [
    "http://example.com/a",
    "https://user:password@example.com/a",
    "https://example.com/a#b",
    "https://example.com/" + "a".repeat(1024),
  ])
    assert.throws(() =>
      validate("ota.install", { device_id, kind: "python", url }),
    );
  assert.throws(() =>
    validate("ota.install", {
      device_id,
      kind: "app",
      url: "https://example.com/a",
    }),
  );
});

test("PaperDIY verification counts only press events from the two user buttons", () => {
  validate("devices.create", { board: "m5stack/paper-diy", name: "PaperDIY" });
  const fixture = `import sys, time
from unittest.mock import MagicMock, call
m5 = MagicMock()
m5.getBoard.return_value = m5.BOARD.M5PaperDIY
m5.Power.getBatteryVoltage.return_value = 3920
m5.BtnA.wasPressed.side_effect = [True, False, False, True]
m5.BtnB.wasPressed.side_effect = [False, False, True, False]
sys.modules['M5'] = m5
sys.modules['okou'] = MagicMock(wifi_rssi=lambda: -55)
time.sleep_ms = lambda ms: None
try: exec(sys.stdin.read(), {})
except StopIteration: pass
assert m5.Widgets.Label.return_value.setText.call_args_list == [
    call('A: 1   B: 0'), call('A: 1   B: 1'), call('A: 2   B: 1')]
`;
  execFileSync("python3", ["-I", "-c", fixture], {
    input: provisioning("m5stack/paper-diy").verification_source,
  });
});

test("StackChan verification maps touches and releases to paired strip LEDs", () => {
  validate("devices.create", { board: "m5stack/stackchan", name: "StackChan" });
  const fixture = `import sys, time
from unittest.mock import MagicMock, call
m5 = MagicMock()
m5.getBoard.return_value = m5.BOARD.M5StackChan
sys.modules['M5'] = m5
sys.modules['okou'] = MagicMock(wifi_rssi=lambda: -55)
hardware = MagicMock()
sys.modules['hardware.stackchan'] = hardware
body = hardware.StackChan.return_value
body.get_battery_voltage.return_value = 4.0
body.get_touch.side_effect = [[1,0,0], [1,0,0], [0,1,0], [0,0,1], [0,0,0]]
time.sleep_ms = lambda ms: None
try: exec(sys.stdin.read(), {})
except StopIteration: pass
expected = []
for zone, color in enumerate((0x33cc00, 0x00cccc, 0x000099)):
    for value in (color, 0):
        for strip in (0, 1):
            for index in (2*zone, 2*zone+1):
                expected.append(call(strip, index, value))
assert body.set_rgb_color.call_args_list == expected
body.set_servo_power.assert_not_called()
`;
  execFileSync("python3", ["-I", "-c", fixture], {
    input: provisioning("m5stack/stackchan").verification_source,
  });
});

test("local upload sizes match the bootloader limits", () => {
  const device_id = crypto.randomUUID();
  validate("programs.publish", { device_id, source: "x".repeat(32768) });
  assert.throws(() =>
    validate("programs.publish", { device_id, source: "é".repeat(16385) }),
  );
  assert.throws(() =>
    validate("ota.prepare_upload", { device_id, kind: "python", size: 20 }),
  );
  for (const [kind, limit] of [
    ["bootloader", 4194304],
    ["micropython", 4194304],
    ["native", 4194304],
  ]) {
    validate("ota.prepare_upload", { device_id, kind, size: limit });
    for (const size of [-1, 0, 1.5, limit + 1])
      assert.throws(() =>
        validate("ota.prepare_upload", { device_id, kind, size }),
      );
  }
});
