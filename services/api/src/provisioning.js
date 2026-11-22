const models = { stopwatch: "Stopwatch", "cardputer-adv": "Cardputer-Adv", "paper-color": "Paper Color" };

function verificationSource(board) {
  if (board === "cardputer-adv") {
    // Draw directly to the 240x135 display on this board without PSRAM.
    return `import M5
import okou
import time
from hardware import MatrixKeyboard

M5.begin()
assert M5.getBoard() == M5.BOARD.M5CardputerADV, 'Expected Cardputer-Adv'
lcd = M5.Lcd
lcd.setRotation(1)
if lcd.width() < lcd.height():
    lcd.setRotation(0)
lcd.setBrightness(160)
lcd.fillScreen(0x000000)
lcd.setTextColor(0xffffff, 0x000000)
lcd.setTextSize(2)
lcd.drawString('Cardputer-Adv', 8, 8)
lcd.drawString('Powered by ESPHub.ai', 0, 36)
lcd.setTextSize(1)
rssi = okou.wifi_rssi()
lcd.drawString('Wi-Fi %s  Battery %s%%' % (rssi, M5.Power.getBatteryLevel()), 8, 72)
keyboard = MatrixKeyboard()
lcd.drawString('Press a key', 8, 98)
print('ESP Hub hello drawn: cardputer-adv', lcd.width(), lcd.height())
while True:
    M5.update()
    if keyboard.is_pressed():
        key = keyboard.get_key()
        lcd.fillRect(8, 98, 218, 24, 0x000000)
        lcd.drawString('Key: %s' % (chr(key) if 32 <= key < 127 else key), 8, 98)
        print('Keyboard event:', key)
    time.sleep_ms(20)
`;
  }
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
      `Identify the USB board. If the port or model is ambiguous, ask the user. All supported models use ESP32-S3. Proceed only with the registered M5Stack ${models[board]}.`,
      "Read setup_manifest and match its board to the device. Download the ZIP over HTTPS from its GitHub Releases download_url, then flash over USB using INSTALL.txt and flash_args. First-time installation replaces the partition table and app. If the board has data to keep, confirm a backup before flashing.",
      "Open the launcher USB serial port at 115200 baud and send wifi scan followed by a newline. Number the device's results. Ask which number to join, or accept a hidden SSID. Collect the password privately on the host for a secured network.",
      'Send one newline-terminated USB line using this template: OKL-PROVISION {"hub":"<hub>","token":"<token>","wifi":{"ssid":"<ssid>","pass":"<password>","hidden":false}}. JSON-encode the actual values locally. Set hidden to true for a hidden SSID and use an empty pass for an open network. Keep credentials out of chat and logs. Wait for OKL-PROVISION-OK.',
      "Poll devices.get with this registration ID until it is online with the matching board and role app. Stage verification_source with programs.publish. Call launcher.enter, wait for the online launcher, then call ota.install with kind python and the staged URL. Use uart.read on the returned process_id after the cursor to check install.done for the transfer_id. Wait for a new app boot and read its output for program.applied and the board-specific hello. Report what the board confirmed.",
    ].join("\n"),
    setup_manifest: base + "setup-manifest",
    verification_source: verificationSource(board),
  };
}
