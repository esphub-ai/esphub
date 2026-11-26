# EspHub firmware and flash layout

| Component | Role | Flash location |
| --- | --- | --- |
| ESP-IDF bootloader | Reads the partition table and OTA selection and boots an ESP image. | Second-stage bootloader region. |
| EspHub Bootloader | Provides USB/BLE provisioning, recovery and binary OTA. | `launcher_a` and `launcher_b` use ESP-IDF subtypes `ota_0` and `ota_1`. These labels and their maintenance role belong to EspHub. |
| Application | Runs a board example or custom firmware. | `app` uses subtype `ota_2`. |
| EspHub SDK | Connects a bootloader or application to the Hub. Applications call `eh_agent_start()`. | Linked into the image. |

## Updates and recovery

A new USB kit installs the ESP-IDF bootloader, partition table, EspHub Bootloader, initial configuration and default example. Applications and the maintenance firmware share network credentials in NVS. The active EspHub Bootloader can install either an application or a replacement bootloader.

A bootloader update validates the inactive maintenance slot before selecting it. Application OTA writes the single `app` slot. The maintenance firmware stays available to retry an interrupted download. An image that passes validation and then crashes has no automatic application rollback. A physical recovery path or a USB kit may be necessary.

## Capacity

| Flash | Each EspHub Bootloader slot | Application | Board data partition |
| --- | --- | --- | --- |
| 8 MiB | 1.25 MiB | 4 MiB | 1.375 MiB |
| 16 MiB | 2 MiB | 4 MiB | 7.875 MiB |
| 32 MiB | 2 MiB | 4 MiB | 23.875 MiB |

The `data` partition is available to the application. NVS stores credentials and pending receipts. `otadata` holds ESP-IDF boot selection and `phy_init` stores radio configuration. OTA uses the partition table already on the board.
