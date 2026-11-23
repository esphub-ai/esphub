import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { readFileSync, statSync } from "node:fs";
import boards from "../shared/boards.generated.json" with { type: "json" };
import { updateSources } from "../services/api/src/update-sources.js";
import { provisioning } from "../services/api/src/provisioning.js";
import { validate } from "../services/api/src/operations.js";

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

test("Paper Color and StopWatch verification programs draw the measured status and greeting in a single frame", () => {
  for (const [board, model] of [
    ["stopwatch", "Stopwatch"],
    ["paper-color", "Paper Color"],
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
    input: provisioning("cardputer-adv").verification_source,
    encoding: "utf8",
  });
  assert.match(output, /ESP Hub hello drawn: cardputer-adv 240 135/);
  assert.match(output, /Keyboard event: 120/);
});

test("publishing bounds UTF-8 byte size and OTA accepts only the three HTTPS targets", () => {
  const device_id = crypto.randomUUID();
  assert.throws(
    () =>
      validate("programs.publish", { device_id, source: "é".repeat(16385) }),
    /Invalid source/,
  );
  for (const kind of ["bootloader", "micropython", "python"])
    validate("ota.install", {
      device_id,
      kind,
      url: "https://example.com/artifact",
    });
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
  assert.throws(
    () => validate("programs.install", { device_id, source: "print(1)" }),
    /Unknown tool/,
  );
});

test("runtime starts without opening main.py for network reporting", () => {
  const script = `import os, sys, tempfile, types
from pathlib import Path
boot = compile(Path("firmware/pyrt/overlay/okl/_boot.py").read_text(), "_boot.py", "exec")
def module(name, **methods):
    sys.modules[name] = types.SimpleNamespace(**methods)
with tempfile.TemporaryDirectory() as root:
    module("vfs", mount=lambda *a: None)
    module("esp32", Partition=types.SimpleNamespace(TYPE_DATA=1, find=lambda *a, **k: [object()]))
    module("okou", safe_boot=lambda: False)
    module("micropython", alloc_emergency_exception_buf=lambda size: None)
    module("os", chdir=lambda path: os.chdir(root), rename=os.rename, remove=os.remove)
    main = Path(root, "main.py")
    main.write_text("print('old')")
    Path(root, ".esphub-download").write_text("print('partial')")
    exec(boot, {"open": lambda *a: (_ for _ in ()).throw(AssertionError("unexpected file read"))})
    assert main.read_text() == "print('old')"
    main.write_text("if (")
    exec(boot, {"open": lambda *a: (_ for _ in ()).throw(AssertionError("unexpected file read"))})
    assert main.read_text() == "if ("
    main.unlink()
    exec(boot, {"open": lambda *a: (_ for _ in ()).throw(AssertionError("unexpected file read"))})
    main.write_bytes(b"x" * 32769)
    exec(boot, {"open": lambda *a: (_ for _ in ()).throw(AssertionError("unexpected file read"))})
    sys.modules["os"] = os
`;
  execFileSync("python3", ["-I", "-c", script]);
});

test("PaperDIY verification counts only press events from the two user buttons", () => {
  validate("devices.create", { board: "paper-diy", name: "PaperDIY" });
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
    input: provisioning("paper-diy").verification_source,
  });
});

test("StackChan verification maps touches and releases to paired strip LEDs", () => {
  validate("devices.create", { board: "stackchan", name: "StackChan" });
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
    input: provisioning("stackchan").verification_source,
  });
});

test("OTA rejects the retired launcher tool and kind", () => {
  const device_id = "00000000-0000-4000-8000-000000000001";
  assert.throws(
    () => validate("launcher.enter", { device_id }),
    /Unknown tool/,
  );
  assert.throws(() => validate("ota.install", { device_id, kind: "launcher" }));
  assert.throws(() =>
    validate("ota.prepare_upload", { device_id, kind: "launcher", size: 1 }),
  );
  validate("bootloader.enter", { device_id });
  validate("ota.install", { device_id, kind: "bootloader" });
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
  ]) {
    validate("ota.prepare_upload", { device_id, kind, size: limit });
    for (const size of [-1, 0, 1.5, limit + 1])
      assert.throws(() =>
        validate("ota.prepare_upload", { device_id, kind, size }),
      );
  }
});
