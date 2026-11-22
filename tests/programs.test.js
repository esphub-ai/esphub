import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { installProgram } from "../services/api/src/programs.js";
import { provisioning } from "../services/api/src/provisioning.js";
import { validate } from "../services/api/src/operations.js";

test("both verification programs draw the measured status and greeting in a single frame", () => {
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

test("refuses an unacknowledged checksum and bounds source by UTF-8 size", async () => {
  const input = { device_id: crypto.randomUUID(), source: "é".repeat(16385) };
  assert.throws(() => validate("programs.install", input), /Invalid source/);
  await assert.rejects(
    installProgram("print(1)", (op) => {
      assert.equal(op, "py.exec");
      return { exception: null, output: "" };
    }),
    /checksum receipt/,
  );
});
