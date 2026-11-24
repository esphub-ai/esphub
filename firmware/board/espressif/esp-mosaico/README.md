# Espressif ESP-Mosaico

ESP-Mosaico uses the `esp32s31-16mb-usb-cdc` EspHub bootloader and boots from 16 MiB SPI NOR.
Its 16 MiB PSRAM and 128 MiB SPI NAND are separate from the boot flash.
[Official board guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s31/esp-mosaico/user_guide.html)

The bootloader uses USB OTG CDC for provisioning through the onboard USB-C port.
Early ESP-IDF boot messages use UART0.

The preview MicroPython Runtime uses a pinned [upstream ESP32-S31 port](https://github.com/micropython/micropython/pull/19726)
and ESP-IDF 6.1.1. It runs from the `app` partition and reads [main.py](main.py)
from the LittleFS `data` partition. The example prints the board name to the console.
CI also assembles a first-time USB kit with both images and the matching
`setup-manifest`. ESP-Mosaico remains a preview board pending hardware testing
of the Runtime and the complete kit.

## Bootloader-only registration

Register the device as `esp-mosaico` in EspHub to select its board-specific
firmware. Use the board-specific Bootloader USB archive and its `flash_args`.
The Bootloader update preserves the existing NVS partition.

Write the registration token and BLE bootstrap key over USB CDC. Then use the
[Mac BLE tool](../../../../tools/ble-wifi/) to configure Wi-Fi. Verify that
`devices.get` reports the registered board online with role `bootloader`.
The full setup catalog lists boards that have a first-time kit and Runtime.
