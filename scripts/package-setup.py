"""Complete a fresh-device USB kit using the board's launcher build and MicroPython runtime."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("board")
parser.add_argument("launcher", type=Path)
parser.add_argument("runtime", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
profile = Path(__file__).resolve().parents[1] / "firmware/boards" / args.board
recipe = {"tag": os.environ["TAG"], "launcher_version": os.environ["LAUNCHER_VERSION"],
          "runtime_version": os.environ["MICROPYTHON_VERSION"], "launcher_tag": os.environ["LAUNCHER_TAG"],
          "runtime_tag": os.environ["MICROPYTHON_TAG"]}
chip = json.loads((profile / "board.json").read_text())["chip"]
version = os.environ["VERSION"]
prefix = f"esphub-{args.board}-{chip}-{version}-setup"
kit = args.output / (prefix + ".zip")
image = args.runtime.read_bytes()
with ZipFile(args.launcher) as base, ZipFile(kit, "w", ZIP_DEFLATED) as dest:
    rows = csv.reader(base.read("partitions.csv").decode().splitlines(), skipinitialspace=True)
    parts = {row[0]: row for row in rows if row and not row[0].startswith("#")}
    app = parts["app"]
    offset, size = int(app[3], 0), int(app[4], 0)
    assert parts["data"][2] == "littlefs" and 0 < len(image) <= size
    launcher = base.read("esp-launcher.bin")
    for kind, binary in (("launcher", launcher), ("micropython", image)):
        assert binary[0] == 0xE9 and binary[288:].startswith(f"ESPHUB1/{kind}/{args.board}\0".encode())
    assert launcher[12:14] == image[12:14], "Mismatched ESP chips"
    for name in base.namelist():
        if name not in ("flash_args", "INSTALL.txt"):
            dest.writestr(name, base.read(name))
    dest.writestr("micropython.bin", image)
    dest.writestr("flash_args", base.read("flash_args").rstrip() + f"\n{offset:#x} micropython.bin\n".encode())
    erase = "--erase-all " if os.environ.get("ERASE_ALL") == "true" else ""
    dest.writestr("INSTALL.txt", f"""First installation for {args.board} only. Includes the launcher and MicroPython.
This replaces the partition table and application. Back up existing device data first.
From this directory, use the correct local USB port:
esptool.py --chip {chip} --port PORT write_flash {erase}@flash_args
Open the launcher's USB console at 115200 baud and send: wifi scan
""")

manifest = dict(board=args.board, chip=chip, version=version, **recipe, file=kit.name,
                download_url=f"https://github.com/okou-ai/esphub/releases/download/{recipe['tag']}/{kit.name}",
                sha256=hashlib.sha256(kit.read_bytes()).hexdigest(),
                runtime_sha256=hashlib.sha256(image).hexdigest(), runtime_size=len(image))
kit.with_suffix(".json").write_text(json.dumps(manifest, indent=2) + "\n")
