"""Renders the AEGIS application icon source (1024x1024 PNG) using only the standard library.

Run from the repository root:  python tools/make-icon.py
Then regenerate platform icons: npx tauri icon apps/desktop/src-tauri/icons/source.png -o apps/desktop/src-tauri/icons
"""
import struct
import zlib

SIZE = 1024
SS = 3  # supersampling per axis
BACKGROUND = (13, 16, 20)
EMBLEM = (82, 176, 128)
RADIUS = 200
# Delta mark: apex, right tip, tail notch, left tip.
POLYGON = [(512, 212), (792, 800), (512, 664), (232, 800)]


def in_polygon(x, y):
    inside = False
    j = len(POLYGON) - 1
    for i in range(len(POLYGON)):
        xi, yi = POLYGON[i]
        xj, yj = POLYGON[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_rounded_square(x, y):
    cx = min(max(x, RADIUS), SIZE - RADIUS)
    cy = min(max(y, RADIUS), SIZE - RADIUS)
    return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS**2


rows = []
offsets = [(k + 0.5) / SS for k in range(SS)]
for py in range(SIZE):
    row = bytearray([0])
    for px in range(SIZE):
        bg = fg = 0
        for oy in offsets:
            for ox in offsets:
                x, y = px + ox, py + oy
                if in_rounded_square(x, y):
                    bg += 1
                    if in_polygon(x, y):
                        fg += 1
        n = SS * SS
        if bg == 0:
            row += bytes((0, 0, 0, 0))
            continue
        t = fg / bg
        row += bytes(
            (
                round(BACKGROUND[0] + (EMBLEM[0] - BACKGROUND[0]) * t),
                round(BACKGROUND[1] + (EMBLEM[1] - BACKGROUND[1]) * t),
                round(BACKGROUND[2] + (EMBLEM[2] - BACKGROUND[2]) * t),
                round(255 * bg / n),
            )
        )
    rows.append(bytes(row))


def chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    + chunk(b"IEND", b"")
)
with open("apps/desktop/src-tauri/icons/source.png", "wb") as f:
    f.write(png)
print("wrote apps/desktop/src-tauri/icons/source.png", len(png), "bytes")
