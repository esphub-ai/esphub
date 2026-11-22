# MicroPython runtime integration

The MicroPython release workflow builds a runtime for each board using the M5Stack UIFlow2 revision pinned in [upstream.json](upstream.json), the local overlay and ESP-IDF 5.5.5. The first-time setup ZIP includes the matching runtime, launcher, partition table and esptool arguments. All first-time kits use a 4 MiB application slot and a LittleFS data partition. Installing this layout on a previously used board replaces its partition table and can destroy existing data.

The launcher accepts the device token and BLE bootstrap key over USB and provisions Wi-Fi over BLE. After its first hub acknowledgement it selects the MicroPython application partition and restarts. On subsequent normal boots the ESP bootloader starts that partition directly. USB setup, recovery and firmware maintenance can return to the launcher. The application SDK manages the hub connection and application input and log forwarding. The frozen boot module mounts the data partition at /flash and runs main.py. Scripts can use okou.wifi_rssi() to read the connected network's RSSI in dBm, or None if disconnected.

The separate StopWatch launcher-only USB kit retains the legacy storage layout. Its application slot and filesystem are incompatible with the fresh-device runtime. Use the first-time setup layout for Python OTA. The runtime accepts application data through okou.read_input() and writes print() output to USB and ESP Hub. Python deployments use launcher HTTPS OTA.

In the device workspace, **Firmware** shows the launcher, interpreter and runtime build separately. On boot the runtime snapshots the selected `/flash/main.py` after staging and validation, then sends it over authenticated HTTPS after the Hub acknowledges the boot. The device owner can read that snapshot offline in Firmware or with `programs.get`. Source is limited to 32 KiB and kept out of boot metadata and serial logs. Older runtimes without snapshots report source as unavailable.

The launcher leaves the board power controller in its existing state. On StopWatch, an application that arms the M5PM1 watchdog must disarm it before handing control to the launcher for an update.
