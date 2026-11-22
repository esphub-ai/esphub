# MicroPython runtime integration

The MicroPython release workflow builds a runtime for each board using M5Stack UIFlow2 commit a61a29409f09f1f4bebae05e15c4bd6dcc4956b6, the local overlay and ESP-IDF 5.5.5. The first-time setup ZIP includes the matching runtime, launcher, partition table and esptool arguments. Both first-time kits use a 4 MiB application slot and a LittleFS data partition. Installing this layout on a previously used board replaces its partition table and can destroy existing data.

The launcher provisions Wi-Fi and the device token over USB. After its first hub acknowledgement it selects the MicroPython application partition and restarts. On subsequent normal boots the ESP bootloader starts that partition directly. USB setup, recovery and firmware maintenance can return to the launcher. The application SDK manages the hub connection and USB terminal mirroring. The frozen boot module mounts the data partition at /flash and runs main.py. Scripts can use okou.wifi_rssi() to read the connected network's RSSI in dBm, or None if disconnected.

The separate StopWatch launcher-only USB kit retains the legacy storage layout. Its application slot and filesystem are incompatible with the fresh-device runtime. Use the MCP program installer on boards already running ESP Hub MicroPython.
