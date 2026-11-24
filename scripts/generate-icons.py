#!/usr/bin/env python3
"""Generate T-Tax icons for macOS (.icns + monochrome tray Template PNG) and Windows (.ico)."""

from pathlib import Path
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "apps" / "desktop" / "resources"
RES.mkdir(parents=True, exist_ok=True)


def write_png(path: Path, width: int, height: int, rgba_bytes: bytes) -> None:
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    rows = bytearray()
    stride = width * 4
    for y in range(height):
        rows.append(0)
        rows.extend(rgba_bytes[y * stride : (y + 1) * stride])
    idat = zlib.compress(bytes(rows), 9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    path.write_bytes(png)


def render_app_icon(size: int) -> bytes:
    """Minimal geometric T-Tax ledger/squircle mark — flat obsidian + cobalt crisp stroke."""
    buf = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2.0
    r_outer = size * 0.44
    corner = size * 0.22

    def sdf_round_box(px: float, py: float, half: float, rad: float) -> float:
        qx = abs(px - cx) - (half - rad)
        qy = abs(py - cy) - (half - rad)
        import math

        ox = max(qx, 0.0)
        oy = max(qy, 0.0)
        return math.hypot(ox, oy) + min(max(qx, qy), 0.0) - rad

    def in_rect(px: float, py: float, x0: float, y0: float, x1: float, y1: float) -> bool:
        return x0 <= px <= x1 and y0 <= py <= y1

    s = float(size)
    for y in range(size):
        for x in range(size):
            d = sdf_round_box(x, y, r_outer, corner)
            idx = (y * size + x) * 4
            if d > 1.0:
                continue
            alpha = 255 if d <= -0.5 else max(0, min(255, int((1.0 - d) * 170)))
            # Specular hairline border at top/rim
            if -max(1.5, s * 0.014) <= d <= 0.5:
                r, g, b = 78, 92, 128
            else:
                # Deep obsidian slate
                r, g, b = 18, 22, 32

            # Geometric "T" ledger bars (top crisp white + cyan accent bar)
            top_bar = in_rect(x, y, s * 0.25, s * 0.28, s * 0.75, s * 0.37)
            stem = in_rect(x, y, s * 0.44, s * 0.37, s * 0.56, s * 0.73)
            ledger_line1 = in_rect(x, y, s * 0.27, s * 0.48, s * 0.39, s * 0.54)
            ledger_line2 = in_rect(x, y, s * 0.61, s * 0.48, s * 0.73, s * 0.54)
            accent_dot = in_rect(x, y, s * 0.61, s * 0.60, s * 0.73, s * 0.68)

            if top_bar or stem:
                r, g, b = 244, 246, 250
            elif ledger_line1 or ledger_line2:
                r, g, b = 56, 189, 248
            elif accent_dot:
                r, g, b = 37, 99, 235

            buf[idx] = r
            buf[idx + 1] = g
            buf[idx + 2] = b
            buf[idx + 3] = alpha
    return bytes(buf)


def render_tray_template(size: int) -> bytes:
    """Monochrome template glyph for macOS Menu Bar (black + alpha only)."""
    buf = bytearray(size * size * 4)
    s = float(size)
    cx = cy = (size - 1) / 2.0
    import math

    def sdf_round_box(px: float, py: float, half: float, rad: float) -> float:
        qx = abs(px - cx) - (half - rad)
        qy = abs(py - cy) - (half - rad)
        return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - rad

    for y in range(size):
        for x in range(size):
            d = sdf_round_box(x, y, s * 0.42, s * 0.16)
            ring = abs(d) < max(1.1, s * 0.075)
            top_bar = s * 0.28 <= x <= s * 0.72 and s * 0.31 <= y <= s * 0.40
            stem = s * 0.45 <= x <= s * 0.55 and s * 0.40 <= y <= s * 0.71
            if ring or top_bar or stem:
                idx = (y * size + x) * 4
                buf[idx] = 0
                buf[idx + 1] = 0
                buf[idx + 2] = 0
                buf[idx + 3] = 240
    return bytes(buf)


def write_ico(path: Path, png_map: dict[int, bytes]) -> None:
    sizes = sorted(png_map.keys())
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = bytearray()
    blobs = bytearray()
    for sz in sizes:
        raw = png_map[sz]
        w_byte = 0 if sz >= 256 else sz
        entries.extend(struct.pack("<BBBBHHII", w_byte, w_byte, 0, 0, 1, 32, len(raw), offset))
        blobs.extend(raw)
        offset += len(raw)
    path.write_bytes(header + bytes(entries) + bytes(blobs))


def main() -> None:
    icon_1024 = render_app_icon(1024)
    write_png(RES / "icon.png", 1024, 1024, icon_1024)

    # Monochrome Menu Bar Template Icons (@1x 18px, @2x 36px)
    write_png(RES / "trayTemplate.png", 18, 18, render_tray_template(18))
    write_png(RES / "trayTemplate@2x.png", 36, 36, render_tray_template(36))

    # Windows .ico (16, 32, 48, 256)
    ico_pngs: dict[int, bytes] = {}
    for sz in (16, 32, 48, 256):
        p = RES / f".tmp_{sz}.png"
        write_png(p, sz, sz, render_app_icon(sz))
        ico_pngs[sz] = p.read_bytes()
        p.unlink()
    write_ico(RES / "icon.ico", ico_pngs)

    # macOS .icns via iconutil if available
    if sys.platform == "darwin":
        iconset = RES / "T-Tax.iconset"
        iconset.mkdir(exist_ok=True)
        for sz in (16, 32, 128, 256, 512):
            write_png(iconset / f"icon_{sz}x{sz}.png", sz, sz, render_app_icon(sz))
            write_png(iconset / f"icon_{sz}x{sz}@2x.png", sz * 2, sz * 2, render_app_icon(sz * 2))
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(RES / "icon.icns")], check=True)
        for f in iconset.iterdir():
            f.unlink()
        iconset.rmdir()

    print("Generated icons in", RES)


if __name__ == "__main__":
    main()
