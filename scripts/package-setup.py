"""Complete a fresh-device USB kit using the board's bootloader build and MicroPython runtime."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("board")
parser.add_argument("bootloader", type=Path)
parser.add_argument("runtime", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
profile = Path(__file__).resolve().parents[1] / "firmware/boards" / args.board
recipe = {"tag": os.environ["TAG"], "bootloader_version": os.environ["BOOTLOADER_VERSION"],
          "runtime_version": os.environ["MICROPYTHON_VERSION"], "bootloader_tag": os.environ["BOOTLOADER_TAG"],
          "runtime_tag": os.environ["MICROPYTHON_TAG"]}
metadata = json.loads((profile / "board.json").read_text())
chip = metadata["chip"]
version = os.environ["VERSION"]
prefix = f"esphub-{args.board}-{chip}-{version}-setup"
kit = args.output / (prefix + ".zip")
image = args.runtime.read_bytes()
with ZipFile(args.bootloader) as base, ZipFile(kit, "w", ZIP_DEFLATED) as dest:
    rows = csv.reader(base.read("partitions.csv").decode().splitlines(), skipinitialspace=True)
    parts = {row[0]: row for row in rows if row and not row[0].startswith("#")}
    app = parts["app"]
    offset, size = int(app[3], 0), int(app[4], 0)
    assert parts["data"][2] == "littlefs" and 0 < len(image) <= size
    bootloader = base.read("esp-bootloader.bin")
    variant = metadata["bootloader"]
    assert bootloader[0] == 0xE9 and bootloader[288:].startswith(
        f"ESPHUB2/bootloader/{variant}\0bootloader-ota-v2\0".encode())
    assert image[0] == 0xE9 and image[288:].startswith(
        f"ESPHUB2/micropython/{args.board}\0bootloader-ota-v2\0".encode())
    assert bootloader[12:14] == image[12:14], "Mismatched ESP chips"
    for name in base.namelist():
        if name not in ("flash_args", "INSTALL.txt"):
            dest.writestr(name, base.read(name))
    dest.writestr("micropython.bin", image)
    dest.write(profile / "hello.py", "main.py")
    flash_args = base.read("flash_args").rstrip() + f"\n{offset:#x} micropython.bin\n".encode()
    name = "board-nvs.bin"
    assert len(base.read(name)) == int(parts["nvs"][4], 0)
    flash_args += f"{parts['nvs'][3]} {name}\n".encode()
    dest.writestr("flash_args", flash_args)
    setup_note = ("Write the plain hub hostname, token and ble_secret from devices.create with OKL-PROVISION over USB at 115200.\n"
                  "Run the macOS BLE Wi-Fi tool and restart the board after Beacon ready.")
    dest.writestr("INSTALL.txt", f"""First installation for {args.board} only. Includes the bootloader and MicroPython.
This erases flash and replaces the partition table and application. Back up existing device data first.
From this directory, use the correct local USB port:
esptool.py --chip {chip} --port PORT write_flash --erase-all @flash_args
The included main.py is the board verification example. Install it after setup using Python OTA.
{setup_note}
""")

repository = os.environ.get("GITHUB_REPOSITORY", "okou-ai/esphub")
manifest = dict(board=args.board, chip=chip, version=version, **recipe, file=kit.name,
                download_url=f"https://github.com/{repository}/releases/download/{recipe['tag']}/{kit.name}",
                sha256=hashlib.sha256(kit.read_bytes()).hexdigest(),
                runtime_sha256=hashlib.sha256(image).hexdigest(), runtime_size=len(image))
kit.with_suffix(".json").write_text(json.dumps(manifest, indent=2) + "\n")
