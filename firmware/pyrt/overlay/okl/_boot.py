# SPDX-License-Identifier: MIT
# esp-launcher Python runtime boot (replaces UIFlow's _boot.py): no UIFlow menu, Wi-Fi or cloud.
# The okou_agent SDK (C) already owns Wi-Fi and the hub connection before this runs.
import gc
import os
import sys
import vfs
import esp32
import micropython
import okou

# print() / REPL output also goes to the hub log stream.
os.dupterm(okou.term(), 0)

# User files live on the `data` partition (LittleFS), mounted at /flash.
_p = esp32.Partition.find(esp32.Partition.TYPE_DATA, label="data")
if _p:
    try:
        vfs.mount(_p[0], "/flash")
    except OSError:
        # Only initialize erased flash. Preserve an existing filesystem on mount errors.
        virgin = bytearray(256)
        for block in (0, 1):
            _p[0].readblocks(block, virgin, 0)
            if virgin != b"\xff" * len(virgin):
                raise
        print("okl: formatting the data partition (LittleFS)")
        vfs.VfsLfs2.mkfs(_p[0])
        vfs.mount(_p[0], "/flash")
    os.chdir("/flash")
    sys.path.append("/flash/lib")
    # LittleFS rename atomically replaces the old program after a syntax check.
    try:
        staged = open(".esphub-next.py", "r")
    except OSError as exc:
        if exc.errno != 2:
            raise
    else:
        try:
            with staged:
                compile(staged.read(), "main.py", "exec")
            os.rename(".esphub-next.py", "main.py")
            print("program.applied main.py")
        except (SyntaxError, ValueError, MemoryError) as exc:
            os.remove(".esphub-next.py")
            print("program.rejected", exc)
del _p

micropython.alloc_emergency_exception_buf(256)
gc.collect()

# main.c runs main.py only if this is truthy. A safe boot (hub op py.safe_boot) skips it once,
# so a main.py that wedges the interpreter can still be replaced remotely.
_uiflow_run_main = not okou.safe_boot()
if not _uiflow_run_main:
    print("okl: safe boot, main.py skipped")
