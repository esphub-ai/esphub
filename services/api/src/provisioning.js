const models = { stopwatch: "Stopwatch", "paper-color": "Paper Color" };

function verificationSource(board) {
  const paper = board === "paper-color";
  return `import M5
import okou
from M5 import Widgets

lcd = M5.Lcd
${paper ? "lcd.setRotation(1)\nlcd.setEpdMode(lcd.EPDMode.EPD_TEXT)" : "lcd.setBrightness(160)"}
w, h = lcd.width(), lcd.height()
canvas = lcd.newCanvas(w, h, ${paper ? 24 : 16}, True)

def center(text, y, font):
    canvas.setFont(font)
    canvas.drawString(text, (w - canvas.textWidth(text)) // 2, y)

try:
    canvas.fillScreen(0xffffff)
    canvas.setTextColor(0x000000, 0xffffff)
    rssi = okou.wifi_rssi()
    level = M5.Power.getBatteryLevel()
    wifi = '%d dBm' % rssi if rssi is not None else 'offline'
    battery = '%d%%' % level if 0 <= level <= 100 else 'unavailable'
    center('Wi-Fi ' + wifi + '   Battery ' + battery, h // 7, Widgets.FONTS.Montserrat16)
    center('Hello, M5Stack ${models[board]}', h // 2 - 28, Widgets.FONTS.Montserrat24)
    center('Powered by ESPHub.ai', h // 2 + 12, Widgets.FONTS.Montserrat24)
    canvas.push(0, 0)
finally:
    canvas.delete()
print('ESP Hub hello drawn: ${board}')
`;
}

export function provisioning(board) {
  const base = `https://api.esphub.ai/releases/${board}/`;
  return {
    prompt: [
      `Identify the USB board. If the port or model is ambiguous, ask the user. Both models use ESP32-S3. Proceed only with the registered M5Stack ${models[board]}.`,
      "Read setup_manifest and match its board to the device. Download https://github.com/okou-ai/esphub/releases/download/launcher-v{version}/{file} using the manifest fields. Verify the ZIP against sha256, then flash over USB using INSTALL.txt and flash_args. First-time installation replaces the partition table and app. If the board has data to keep, confirm a backup before flashing.",
      "Open the launcher USB serial port at 115200 baud and send wifi scan followed by a newline. Number the device's results. Ask which number to join, or accept a hidden SSID. Collect the password privately on the host for a secured network.",
      'Send one newline-terminated USB line using this template: OKL-PROVISION {"hub":"<hub>","token":"<token>","wifi":{"ssid":"<ssid>","pass":"<password>","hidden":false}}. JSON-encode the actual values locally. Set hidden to true for a hidden SSID and use an empty pass for an open network. Keep credentials out of chat and logs. Wait for OKL-PROVISION-OK.',
      "Poll devices.get with this registration ID until it is online with the matching board and role app. Call programs.install with verification_source. Check the checksum receipt and read uart.read after the returned cursor for the matching hello marker. Report what the board confirmed.",
    ].join("\n"),
    setup_manifest: base + "setup-manifest",
    verification_source: verificationSource(board),
  };
}
