# Espressif ESP-Mosaico

ESP-Mosaico uses the `esp32s31-16mb-usb-cdc` EspHub bootloader and boots from 16 MiB SPI NOR.
Its 16 MiB PSRAM and 128 MiB SPI NAND are separate from the boot flash.
[Official board guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s31/esp-mosaico/user_guide.html)

The bootloader uses USB OTG CDC for provisioning through the onboard USB-C port.
Early ESP-IDF boot messages use UART0.

[main.py](main.py) is a console example for a future MicroPython runtime. The pinned
UIFlow upstream has no ESP32-S31 runtime target. Only bootloader artifacts are configured
for this board.

## Bootloader-only registration

After the API supports this board, register it as `esp-mosaico`. Use the
board-specific bootloader USB archive. For an empty NVS partition, initialize
the board identity with the archive's `board-nvs.bin` at the `nvs` offset
from `partitions.csv`. Writing that image replaces the NVS partition, so back
up existing NVS before any such write. The bootloader-only upgrade in
`flash_args` preserves existing NVS.

Write the registration token and BLE bootstrap key over USB CDC. Then use the
[Mac BLE tool](../../../../tools/ble-wifi/) to configure Wi-Fi. Verify that
`devices.get` reports the registered board online with role `bootloader`.
The full setup catalog lists boards that have a first-time kit and Runtime.
