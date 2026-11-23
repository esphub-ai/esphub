# EspHub firmware terminology and flash layout

EspHub has three deployment targets: the EspHub Bootloader, a Runtime, and a Program. A Program can be a script executed by a Runtime or a native firmware image that boots directly. A `.bin` extension identifies a file format; the image's intended role determines where it belongs.

## Glossary

| Term | What it does | Where it lives in the single-slot design |
| --- | --- | --- |
| ESP-IDF bootloader | After the ESP32 ROM starts it, it reads the partition table and OTA boot-selection metadata, then loads the selected executable. | Bootloader region before the partition table. |
| EspHub Bootloader | Provides device setup, maintenance, and OTA installation. It selects the application image to start on reboot. Existing code and API identifiers call it the bootloader. | `bl` partition, ESP-IDF type/subtype `app/ota_0`. |
| EspHub SDK | Provides device-side integration with EspHub, including networking, commands, and console forwarding. A Native Program can integrate it too. | Linked into each firmware image that uses it. It has no separate partition. |
| Runtime | Provides an execution environment for a Program. EspHub currently provides the MicroPython Runtime. | `app` partition, type/subtype `app/ota_1`. |
| Program | The application the user wants the device to run. Its form determines how it starts and how it is installed. | One of the two forms below. |
| Python Program | The MicroPython Runtime opens and executes `main.py`. Updating this file leaves the interpreter installed. | `/flash/main.py` in the `data` LittleFS partition on fresh installations. |
| Native Program | A board-compatible executable image that the EspHub Bootloader selects to boot directly. It can run independently of MicroPython. | In the target design, it occupies the same `app` partition that would otherwise hold a Runtime. Installing it replaces the Runtime. |

## Boot and update paths

| Installed application | Normal boot | Program update |
| --- | --- | --- |
| MicroPython Runtime and Python Program | ESP-IDF bootloader → MicroPython Runtime in `app` → `/flash/main.py` | Write `main.py` in `data`. |
| Native Program (target design) | ESP-IDF bootloader → Native Program in `app` | Write the native image to `app` from the EspHub Bootloader. |

In maintenance mode the ESP-IDF bootloader loads the EspHub Bootloader instead. Normal boots can go directly to the selected application. In the single-slot implementation, updating the EspHub Bootloader itself uses the MicroPython Runtime's native agent to write back to `bl`. A Native Program would need an equivalent writer to retain this OTA capability while it occupies `app`. SDK integration alone does not establish that capability.

Current ESP32-S3 boards share two EspHub Bootloader builds, `esp32s3-8mb` and `esp32s3-16mb`. USB setup writes each board's identity in NVS and installs its partition table independently. Shared bootloaders use that board identity to validate Runtime updates and read the installed partition table at runtime.

## Partition mapping

The two executable partitions are `bl` (EspHub Bootloader) and `app` (application image). The ESP-IDF subtypes `ota_0` and `ota_1` identify these two different executables. There is only one copy of the EspHub Bootloader. The remaining named partitions serve these purposes:

| Label | Contents |
| --- | --- |
| `data` | LittleFS for Python source, libraries, and user files. |
| `nvs` | Persistent device configuration, credentials, and pending update state. |
| `otadata` | ESP-IDF boot selection and OTA image state. |
| `phy_init` | Radio PHY initialization data. |
| `coredump` | Crash diagnostics. |

### Single-slot capacity by layout

These are partition capacities, not compiled binary sizes or available RAM. Addresses are flash offsets.

| Layout | EspHub Bootloader | Runtime or Native Program | User filesystem |
| --- | --- | --- | --- |
| 4 MiB reference | 1.25 MiB at `0x20000` | 2.0625 MiB at `0x160000` | 512 KiB at `0x380000` |
| 8 MiB Cardputer-Adv | 1.25 MiB at `0x20000` | 4 MiB at `0x160000` | 2.5625 MiB at `0x570000` |
| 16 MiB fresh setup (Paper Color, PaperDIY, StackChan, StopWatch) | 1.25 MiB at `0x20000` | 4 MiB at `0x160000` | 10.5625 MiB at `0x570000` |

The 4 MiB layout needs an application image that fits its 2.0625 MiB budget.

## Implementation status and API names

| Product term | Current `ota.install` kind | Status |
| --- | --- | --- |
| EspHub Bootloader | `bootloader` | Supported |
| MicroPython Runtime | `micropython` | Supported |
| Python Program | `python` | Supported |
| Native Program | No kind defined | Target design. A native install target and image identification still need implementation. |
