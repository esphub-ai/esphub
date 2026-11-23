import os

board = os.uname()
print("Hello, ESP-Mosaico")
print("Python runtime:", board.sysname)
print("Machine:", board.machine)
