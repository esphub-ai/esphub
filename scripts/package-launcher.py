"""Run from firmware/launcher after idf.py build; use the generated flash offsets."""
import csv
import hashlib
import re
import json
import os
import sys
import zipfile
from pathlib import Path
from elftools.elf.elffile import ELFFile

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
    apps = [row for row in csv.reader(f, skipinitialspace=True) if len(row) >= 5 and row[1] == "app"]
    assert [(row[0], row[2]) for row in apps] == [("launcher", "ota_0"), ("app", "ota_1")]
    offset = int(apps[0][3], 0)
    assert (build / "esp-launcher.bin").stat().st_size <= int(apps[0][4], 0)
files = parts["flash_files"]
assert any(int(k, 16) == offset and v == "esp-launcher.bin" for k, v in files.items()), files
def digest(data):
    return hashlib.sha256(data).hexdigest()
image = (build / "esp-launcher.bin").read_bytes()
assert image[288:].startswith(f"ESPHUB1/launcher/{board}\0single-launcher-v1\0".encode()), "Invalid OTA image profile"
# Check the linked firmware, including the alternate StopWatch USB layout.
# An MQTT client configured for TLS can still link ESP-IDF's default WS transport.
settings = set(config.splitlines())
for key in ("CONFIG_MQTT_TRANSPORT_SSL", "CONFIG_ESP_HTTP_CLIENT_ENABLE_HTTPS"):
    assert f"{key}=y" in settings, f"Missing {key}"
for key in ("CONFIG_WS_TRANSPORT", "CONFIG_MQTT_TRANSPORT_WEBSOCKET", "CONFIG_MQTT_TRANSPORT_WEBSOCKET_SECURE"):
    assert f"{key}=y" not in settings, f"Unexpected {key}"
with (build / "esp-launcher.elf").open("rb") as elf:
    symbols = {symbol.name for symbol in ELFFile(elf).get_section_by_name(".symtab").iter_symbols()
               if symbol["st_shndx"] != "SHN_UNDEF"}
unexpected = sorted(s for s in symbols if s.startswith(("esp_transport_ws_", "esp_websocket_client_")))
assert not unexpected, f"WebSocket implementation linked: {unexpected}"
required = {"esp_transport_ssl_init", "esp_mqtt_client_start", "esp_http_client_perform", "okou_hub_host_valid"}
assert required <= symbols, f"Missing native transport or hostname validation: {required - symbols}"
lower_image = image.lower()
for marker in (b"upgrade: websocket", b"sec-websocket-", b"esp_transport_ws_", b"ws://", b"wss://"):
    assert marker not in lower_image, f"Unexpected OTA image marker {marker!r}"
print(f"{board} {build}: {len(image)} bytes, SHA-256 {digest(image)}; ELF and binary transport checks passed")
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
