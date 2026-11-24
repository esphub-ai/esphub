#!/bin/sh
# Build a self-contained Debian package from the checked-out source.
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dest=${1:?Usage: package.sh OUTPUT.deb}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
lib="$stage/usr/lib/esphub-wifi"
launcher="$stage/usr/share/APPLaunch"
install -d "$lib" "$stage/DEBIAN" "$launcher/applications" "$launcher/share/images"
install -m 755 "$src/app.py" "$lib/"
install -m 644 "$src/hub.py" "$src/screen.py" "$src/../macos.py" "$src/client-id" "$lib/"
install -m 644 "$src/esphub-wifi.desktop" "$launcher/applications/"
install -m 644 "$src/esphub-wifi.png" "$launcher/share/images/"
cat >"$stage/DEBIAN/control" <<'EOF'
Package: esphub-wifi
Version: 0.1.0
Architecture: all
Maintainer: EspHub contributors
Description: Bluetooth Wi-Fi provisioning GUI for M5Stack Cardputer Zero
Depends: python3 (>= 3.13), python3-bleak (>= 0.22), python3-evdev, python3-pil, python3-numpy, python3-requests, python3-qrcode, fonts-dejavu-core, bluez
EOF
dpkg-deb --root-owner-group --build "$stage" "$dest"
