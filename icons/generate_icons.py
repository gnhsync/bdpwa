#!/usr/bin/env python3
"""
Generate icon-192.png and icon-512.png from icon.svg.
Requires: pip install cairosvg
"""
try:
    import cairosvg
    cairosvg.svg2png(url="icon.svg", write_to="icon-192.png", output_width=192, output_height=192)
    cairosvg.svg2png(url="icon.svg", write_to="icon-512.png", output_width=512, output_height=512)
    print("Icons generated: icon-192.png, icon-512.png")
except ImportError:
    print("cairosvg not installed. Generating minimal placeholder PNGs.")
    # Produce minimal 1x1 transparent PNGs as placeholders so the manifest validates
    import struct, zlib

    def minimal_png(size, out_path):
        def chunk(name, data):
            c = struct.pack(">I", len(data)) + name + data
            return c + struct.pack(">I", zlib.crc32(name + data) & 0xffffffff)

        sig = b"\x89PNG\r\n\x1a\n"
        ihdr_data = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
        row = b"\x00" + b"\x00\x8b\xcb" * size
        raw = row * size
        idat_data = zlib.compress(raw)
        png = sig + chunk(b"IHDR", ihdr_data) + chunk(b"IDAT", idat_data) + chunk(b"IEND", b"")
        with open(out_path, "wb") as f:
            f.write(png)

    minimal_png(192, "icon-192.png")
    minimal_png(512, "icon-512.png")
    print("Placeholder icons written (install cairosvg for proper icons).")
