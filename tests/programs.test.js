import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { provisioning } from "../services/api/src/provisioning.js";
import { validate } from "../services/api/src/operations.js";

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
  for (const kind of ["launcher", "micropython", "python"])
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

test("runtime boot activates complete source and preserves main.py on a rejected or interrupted download", () => {
  const script = `import os, sys, tempfile, types
from pathlib import Path
boot = compile(Path("firmware/pyrt/overlay/okl/_boot.py").read_text(), "_boot.py", "exec")
def module(name, **methods):
    sys.modules[name] = types.SimpleNamespace(**methods)
with tempfile.TemporaryDirectory() as root:
    module("vfs", mount=lambda *a: None)
    module("esp32", Partition=types.SimpleNamespace(TYPE_DATA=1, find=lambda *a, **k: [object()]))
    module("okou", term=lambda: None, safe_boot=lambda: False)
    module("micropython", alloc_emergency_exception_buf=lambda size: None)
    module("os", chdir=lambda path: os.chdir(root), rename=os.rename, remove=os.remove, dupterm=lambda *a: None)
    main = Path(root, "main.py")
    staged = Path(root, ".esphub-next.py")
    main.write_text("print('old')")
    Path(root, ".esphub-download").write_text("print('partial')")
    exec(boot, {})
    assert main.read_text() == "print('old')"
    staged.write_text("print('new')")
    exec(boot, {})
    assert main.read_text() == "print('new')" and not staged.exists()
    staged.write_text("if (")
    exec(boot, {})
    assert main.read_text() == "print('new')" and not staged.exists()
    sys.modules["os"] = os
`;
  const output = execFileSync("python3", ["-I", "-c", script], {
    encoding: "utf8",
  });
  assert.match(output, /program\.applied/);
  assert.match(output, /program\.rejected/);
});
