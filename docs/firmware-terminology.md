# EspHub firmware terminology and flash layout

EspHub has three deployment targets: the EspHub Bootloader, a Runtime, and a Program. A Program can be a script executed by a Runtime or a native firmware image that boots directly. A `.bin` extension identifies a file format; the image's intended role determines where it belongs.

## Glossary

| Term | What it does | Flash location |
| --- | --- | --- |
| ESP-IDF bootloader | After the ESP32 ROM starts it, it reads the partition table and OTA boot-selection metadata, then loads the selected executable. | Bootloader region before the partition table. |
| EspHub Bootloader | Provides device setup, maintenance, and OTA installation. It selects the application image to start on reboot. | `launcher_a` and `launcher_b`, ESP-IDF subtypes `ota_0` and `ota_1`. |
| EspHub SDK | Provides device-side integration with EspHub, including networking, commands, and console forwarding. A Native Program can integrate it too. | Linked into each firmware image that uses it. It has no separate partition. |
| Runtime | Provides an execution environment for a Program. EspHub currently provides the MicroPython Runtime. | `app` partition, type/subtype `app/ota_2`. |
| Program | The application the user wants the device to run. Its form determines how it starts and how it is installed. | One of the two forms below. |
| Python Program | The MicroPython Runtime opens and executes `main.py`. Updating this file leaves the interpreter installed. | `/flash/main.py` in the `data` LittleFS partition on fresh installations. |
| Native Program | A board-compatible executable image that the EspHub Bootloader selects to boot directly. It can run independently of MicroPython. | It occupies the same `app` partition that would otherwise hold a Runtime. Installing it replaces the Runtime. |

## Boot and update paths

| Installed application | Normal boot | Program update |
| --- | --- | --- |
| MicroPython Runtime and Python Program | ESP-IDF bootloader → MicroPython Runtime in `app` → `/flash/main.py` | Write `main.py` in `data`. |
| Native Program | ESP-IDF bootloader → Native Program in `app` | Write the native image to `app` from the EspHub Bootloader. |

In maintenance mode the ESP-IDF bootloader loads the EspHub Bootloader instead. Normal boots can go directly to the selected application. The active EspHub Bootloader writes and validates the other slot before selecting it for the next boot.

The registration uses the board's `group/project` ID (for example, `m5stack/cardputer-adv`) to select its USB kit, including its partition table. MicroPython Runtime and Python Program install commands carry the registered board to match the Runtime image. A Bootloader update matches the running Bootloader variant. A Native Program uses the ESP image and chip checks. Shared bootloaders read the installed partition table at runtime.

## Partition mapping

The remaining named partitions serve these purposes:

| Label | Contents |
| --- | --- |
| `data` | LittleFS for Python source, libraries, and user files. |
| `nvs` | Persistent device configuration, credentials, and pending update state. |
| `otadata` | ESP-IDF boot selection and OTA image state. |
| `phy_init` | Radio PHY initialization data. |

### Capacity by layout

| Flash | Each BL slot | Application slot | User filesystem |
| --- | --- | --- | --- |
| 8 MiB | 1.25 MiB | 4 MiB | 1.375 MiB |
| 16 MiB | 2 MiB | 4 MiB | 7.875 MiB |
| 32 MiB | 2 MiB | 4 MiB | 23.875 MiB |

SDK 7 setup kits assign the former 64 KiB crash partition to LittleFS. Binary OTA uses the partition table already on the board. Back up user files before installing a new USB kit, which replaces that table.

## Implementation status and API names

| Product term | Current `ota.install` kind | Status |
| --- | --- | --- |
| EspHub Bootloader | `bootloader` | Supported |
| MicroPython Runtime | `micropython` | Supported |
| Python Program | `python` | Supported |
| Native Program | `native` | Supported. Supply the application binary for the intended hardware. |
