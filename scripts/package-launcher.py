"""Run from firmware/launcher after idf.py build; use the generated flash offsets."""
import csv
import hashlib
import re
import json
import os
import sys
import zipfile
from pathlib import Path

board, version = sys.argv[1:3]
setup_base = sys.argv[3:] == ["--setup-base"]
profile = Path("../boards") / board
chip = json.loads((profile / "board.json").read_text())["chip"]
build = Path("build-setup" if setup_base else "build")
out = Path("../../dist")
out.mkdir(exist_ok=True)
prefix = f"esphub-{board}-{chip}-{version}"
parts = json.loads((build / "flasher_args.json").read_text())
config = Path("sdkconfig.setup" if setup_base else "sdkconfig").read_text()
assert f'CONFIG_OKOU_BOARD_PROFILE="{board}"' in config.splitlines()
table = Path(re.search(r'^CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="([^"]+)"$', config, re.M)[1])
with table.open() as f:
    offset = next(int(row[3], 0) for row in csv.reader(f, skipinitialspace=True) if row and row[0] == "launcher_a")
files = parts["flash_files"]
assert any(int(k, 16) == offset and v == "esp-launcher.bin" for k, v in files.items()), files
def digest(data):
    return hashlib.sha256(data).hexdigest()
image = (build / "esp-launcher.bin").read_bytes()
assert image[288:].startswith(f"ESPHUB1/launcher/{board}\0".encode()), "Invalid OTA image profile"
ota = f"{prefix}-ota.bin"
# The fresh USB variant uses the same board profile with another partition layout.
if not setup_base:
    (out / ota).write_bytes(image)
usb = f"{prefix}-fresh-usb.zip" if setup_base else f"{prefix}-usb.zip"
with zipfile.ZipFile(out / usb, "w", zipfile.ZIP_DEFLATED) as z:
    for path in files.values():
        z.write(build / path, path)
    z.write(build / "flash_args", "flash_args")
    z.write(table, "partitions.csv")
    z.writestr("INSTALL.txt", f"For {board} only. Unzip, then run from this directory:\nesptool.py --chip {chip} --port PORT write_flash @flash_args\nUse the ota.bin only for a launcher update on a compatible installed layout.\n")
if setup_base:
    (out / f"{prefix}-fresh-usb.sha256").write_text(f"{digest((out / usb).read_bytes())}  {usb}\n")
    sys.exit(0)
manifest = {"source_commit":os.environ["GITHUB_SHA"], "board":board, "chip":chip, "version":version, "flash_mb":int(parts["flash_settings"]["flash_size"].removesuffix("MB")),
            "partition_sha256":digest(table.read_bytes()), "offsets":files,
            "ota":{"file":ota,"sha256":digest(image),"size":len(image)},
            "usb":{"file":usb,"sha256":digest((out/usb).read_bytes())}}
(out / f"{prefix}.json").write_text(json.dumps(manifest, indent=2)+"\n")
