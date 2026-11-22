# MicroPython runtime integration

This is the application-side overlay for M5Stack UIFlow2 MicroPython, upstream commit a61a29409f09f1f4bebae05e15c4bd6dcc4956b6. Apply it to a prepared upstream checkout with apply_overlay.py, passing the checkout, this repository's firmware directory, M5STACK_PaperColor and the application version. Build using upstream's ESP-IDF 5.5.5 toolchain. The board SDK and terminal hooks are compiled into the application; the launcher does not stay resident after chainloading.

The frozen boot module mounts the data partition, starts the application and attaches the MicroPython terminal to the SDK. USB console output continues locally, and output is also captured in the TX stream. Remote RX records feed the MicroPython stdin ring. External peripheral UARTs are independent. The StopWatch preserved legacy layout has a smaller app slot and different data partition; the Paper Color application image must not be used on it.

Launcher CI builds and releases the launcher only. Application authors must build and size-check their own compatible runtime before installing it in the application slot.
