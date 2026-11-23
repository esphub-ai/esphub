# Espressif ESP-Mosaico

ESP-Mosaico uses the `esp32s31-16mb` EspHub bootloader and boots from 16 MiB SPI NOR.
Its 16 MiB PSRAM and 128 MiB SPI NAND are separate from the boot flash.
[Official board guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s31/esp-mosaico/user_guide.html)

The bootloader uses UART0 for console output in the simulator. The board's native USB
port needs USB OTG CDC firmware support for runtime console and provisioning.

[main.py](main.py) is a console example for a future MicroPython runtime. The pinned
UIFlow upstream has no ESP32-S31 runtime target. Only bootloader artifacts are configured
for this board.
