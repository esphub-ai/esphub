"""Keyboard-first 320 x 170 Cardputer Zero interface."""

import asyncio
import mmap
from pathlib import Path

import numpy as np
import qrcode
from evdev import InputDevice, ecodes
from PIL import Image, ImageDraw, ImageFont


class Back(Exception):
    pass


class Quit(Exception):
    pass


PLAIN = "1234567890-=[]\\;'\x60,./"
SHIFTED = '!@#$%^&*()_+{}|:"~<>?'
PUNCT = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "0",
    "MINUS",
    "EQUAL",
    "LEFTBRACE",
    "RIGHTBRACE",
    "BACKSLASH",
    "SEMICOLON",
    "APOSTROPHE",
    "GRAVE",
    "COMMA",
    "DOT",
    "SLASH",
]
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def visible(s):
    return "".join(c if c.isprintable() else " " for c in str(s))


class Screen:
    def __init__(self, output):
        self.output = output
        self.keys = asyncio.Queue()
        self.font = ImageFont.truetype(FONT, 15)
        self.small = ImageFont.truetype(FONT, 12)

    def draw(self, title, rows=(), *, focus=None, hint="Esc  Back", qr=None):
        image = Image.new("RGB", (320, 170), "#10191b")
        pen = ImageDraw.Draw(image)
        pen.rectangle((0, 0, 319, 29), fill="#193637")
        pen.text((9, 4), visible(title), font=self.font, fill="#c4f4e2")
        start = max(0, (focus or 0) - 4)
        if len(rows) > 5:
            pen.text(
                (310, 7),
                f"{(focus or 0) + 1}/{len(rows)}",
                font=self.small,
                fill="white",
                anchor="ra",
            )
        for i, row in enumerate(rows[start : start + 5], start):
            y = 32 + (i - start) * 23
            selected = focus == i
            if selected:
                pen.rounded_rectangle((4, y, 315, y + 22), radius=4, fill="#a9ead3")
            label = visible(row)
            while label and self.font.getlength(label) > 295:
                label = label[:-2] + "…" if len(label) > 1 else ""
            pen.text(
                (10, y + 1),
                label,
                font=self.font,
                fill="#102523" if selected else "#edf3ef",
            )
        if qr:
            code = qrcode.QRCode(border=4, box_size=1)
            code.add_data(qr)
            bitmap = code.make_image().convert("RGB")
            size = bitmap.width * max(1, 113 // bitmap.width)
            image.paste(
                bitmap.resize((size, size), Image.Resampling.NEAREST), (319 - size, 31)
            )
        pen.line((0, 148, 319, 148), fill="#345052")
        pen.text((8, 151), hint, font=self.small, fill="#a3c8bf")
        self.output(image)

    async def keyboard(self, dev):
        shift = set()
        ctrl = set()
        caps = False
        async for event in dev.async_read_loop():
            if event.type != ecodes.EV_KEY:
                continue
            name = ecodes.KEY.get(event.code, "")
            if not isinstance(name, str):
                continue
            name = name.removeprefix("KEY_")
            if name in ("LEFTSHIFT", "RIGHTSHIFT", "LEFTCTRL", "RIGHTCTRL"):
                group = shift if "SHIFT" in name else ctrl
                (group.add if event.value else group.discard)(name)
            elif event.value == 1 or (
                event.value == 2 and name in ("UP", "DOWN", "BACKSPACE")
            ):
                if name == "CAPSLOCK":
                    caps = not caps
                elif ctrl and name == "Q":
                    self.keys.put_nowait("QUIT")
                elif ctrl:
                    continue
                elif len(name) == 1 and name.isalpha():
                    self.keys.put_nowait(name if bool(shift) != caps else name.lower())
                elif name in PUNCT:
                    self.keys.put_nowait(
                        (SHIFTED if shift else PLAIN)[PUNCT.index(name)]
                    )
                else:
                    self.keys.put_nowait(" " if name == "SPACE" else name)

    async def key(self):
        k = await self.keys.get()
        if k == "ESC":
            raise Back
        if k == "QUIT":
            raise Quit
        return k

    async def menu(self, title, rows, index=0):
        while True:
            self.draw(
                title,
                rows,
                focus=index,
                hint="↑↓  Select      Enter  Open      Esc  Back",
            )
            k = await self.key()
            if k == "ENTER":
                return index
            if k in ("UP", "DOWN"):
                index = (index + (1 if k == "DOWN" else -1)) % len(rows)

    async def entry(self, title, subtitle, limit, *, masked=False):
        value = ""
        while True:
            display = "•" * len(value) if masked else value
            while self.font.getlength(display) > 275:
                display = display[1:]
            self.draw(
                title,
                [subtitle, "", display + "▏"],
                hint="Enter  Connect      Esc  Back"
                if masked
                else "Enter  Next      Esc  Back",
            )
            k = await self.key()
            if k == "ENTER" and (masked or value):
                return value
            if k == "BACKSPACE":
                value = value[:-1]
            elif len(k) == 1 and len((value + k).encode()) <= limit:
                value += k

    async def wait(self, title, rows, action, qr=None):
        self.draw(title, rows, hint="Esc  Cancel", qr=qr)
        task = asyncio.create_task(action)

        async def escape():
            while True:
                await self.key()

        keys = asyncio.create_task(escape())
        try:
            done, _ = await asyncio.wait(
                (task, keys), return_when=asyncio.FIRST_COMPLETED
            )
            if keys in done:
                keys.result()
            return task.result()
        finally:
            for t in (task, keys):
                t.cancel()
            await asyncio.gather(task, keys, return_exceptions=True)

    async def message(self, title, text):
        words = text.split()
        lines = [""]
        for word in words:
            if self.font.getlength(lines[-1] + " " + word) > 295:
                lines.append("")
            lines[-1] = (lines[-1] + " " + word).strip()
        self.draw(title, lines, hint="Enter or Esc  Continue")
        try:
            while await self.key() != "ENTER":
                pass
        except Back:
            pass


def keyboard_device():
    for path in Path("/sys/class/input").glob("event*/device/name"):
        if path.read_text().strip() == "tca8418c":
            return InputDevice("/dev/input/" + path.parents[1].name)
    raise RuntimeError("Cardputer keyboard unavailable")


def framebuffer_output(fb):
    size = Path("/sys/class/graphics/fb0/virtual_size").read_text().strip()
    stride = int(Path("/sys/class/graphics/fb0/stride").read_text())
    depth = int(Path("/sys/class/graphics/fb0/bits_per_pixel").read_text())
    if (size, stride, depth) != ("320,170", 640, 16):
        raise RuntimeError("Unsupported Cardputer framebuffer")
    pixels = mmap.mmap(fb.fileno(), 320 * 170 * 2)

    def draw(image):
        rgb = np.asarray(image, dtype=np.uint16)
        packed = (
            ((rgb[:, :, 0] >> 3) << 11)
            | ((rgb[:, :, 1] >> 2) << 5)
            | (rgb[:, :, 2] >> 3)
        )
        pixels[:] = packed.astype("<u2", copy=False).tobytes()

    return draw
