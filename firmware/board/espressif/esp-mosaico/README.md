# Espressif ESP-Mosaico

ESP-Mosaico uses the `esp32s31-16mb-usb-cdc` EspHub bootloader and boots from 16 MiB SPI NOR.
Its 16 MiB PSRAM and 128 MiB SPI NAND are separate from the boot flash.
Use the onboard USB-C port for bootloader provisioning over USB OTG CDC and UART0 for early boot logs.
[Official board guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s31/esp-mosaico/user_guide.html)

## Native example

The example runtime is Espressif's [HMI demo](https://github.com/esp-mosaico/esp-mosaico-bsp/tree/d1eef04db4c96f027891cdb05aa6c1c5f2cbc5e8/examples/hmi_demo), with the BSP pinned to a revision that detects v1.0, v1.1 and v1.2 hardware. The demo runs the LVGL benchmark on the built-in display with touch enabled. EspHub's SDK starts before the demo and uses the registration and Wi-Fi configuration saved by the bootloader to connect to EspHub over MQTT. ESP-Mosaico currently ships as a preview with a native example runtime.

On a registered board, call `bootloader.enter` and wait for the bootloader to come online. Use `ota.install` with kind `native` and `https://api.esphub.ai/releases/esp-mosaico/native`. Check the install receipt and confirm that `devices.get` reports an online native app with the expected version.

### Build locally

Use the ESP-IDF 6.2 release branch image pinned in [ci.json](ci.json) and an ESP-Mosaico BSP checkout at the revision in [native/upstream.json](native/upstream.json). From this board directory, with the IDF environment active:

```sh
export MOSAICO_BSP=/absolute/path/to/esp-mosaico-bsp
idf.py -C native/project -DPROJECT_VER=1.0.0 app
```

The OTA image is `native/project/build/mosaico_hmi.bin`. Use the EspHub partition layout for installation.

## First-time registration

Register the device as `esp-mosaico` in EspHub. Follow `INSTALL.txt` in the setup ZIP linked by the [setup manifest](https://api.esphub.ai/releases/esp-mosaico/setup-manifest). The kit contains the EspHub Bootloader and native HMI demo. The first-time flash replaces the partition table and application.

Write the private registration over USB CDC, then configure Wi-Fi using the [Mac BLE tool](../../../../tools/ble-wifi/) while the board is in bootloader mode. Check that `devices.get` shows the device online, then call `bootloader.exit`. Verify the HMI on the display and the native runtime version in `devices.get`.
