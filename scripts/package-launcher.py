"""Run from firmware/launcher after idf.py build; use the generated flash offsets."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

board, version = sys.argv[1:]
chip = "esp32s3"
build = Path("build")
out = Path("../../dist")
out.mkdir(exist_ok=True)
prefix = f"esphub-{board}-{chip}-{version}"
parts = json.loads((build / "flasher_args.json").read_text())
table = Path("partitions") / ("16mb.csv" if board == "paper-color" else "16mb-legacy.csv")
offset = "0x20000" if board == "paper-color" else "0x10000"
files = parts["flash_files"]
assert any(int(k, 16) == int(offset, 16) and v == "esp-launcher.bin" for k,v in files.items()), files
assert (("CONFIG_OKL_BOARD_M5_STOPWATCH=y" in Path("sdkconfig").read_text()) == (board == "stopwatch"))
def digest(data):
    return hashlib.sha256(data).hexdigest()
image = (build / "esp-launcher.bin").read_bytes()
ota = f"{prefix}-ota.bin"
(out / ota).write_bytes(image)
usb = f"{prefix}-usb.zip"
with zipfile.ZipFile(out / usb, "w", zipfile.ZIP_DEFLATED) as z:
    for path in files.values():
        z.write(build / path, path)
    z.write(build / "flash_args", "flash_args")
    z.write(table, "partitions.csv")
    z.writestr("INSTALL.txt", f"For {board} only. Unzip, then run from this directory:\nesptool.py --chip {chip} --port PORT write_flash @flash_args\nUse the ota.bin only for a launcher update on a compatible installed layout.\n")
manifest = {"board":board, "chip":chip, "version":version, "flash_mb":16,
            "partition_sha256":digest(table.read_bytes()), "offsets":files,
            "ota":{"file":ota,"sha256":digest(image),"size":len(image)},
            "usb":{"file":usb,"sha256":digest((out/usb).read_bytes())}}
(out / f"{prefix}.json").write_text(json.dumps(manifest, indent=2)+"\n")
