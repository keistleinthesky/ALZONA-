"""
Printing Baybayin on the GOOJPRT PT-210.
============================================================================
A 58mm thermal printer with a 384-dot head at 203dpi — 48mm of printable
width. Nothing about it resembles the sheet-fed printer the original code was
written for: there is no page, no margins to centre within, and no greyscale.
Every dot is burned or it is not.

It is NOT installed as a Windows printer and does not need to be. Windows binds
its usbprint class driver to the device, which exposes a writable device
interface, so ESC/POS bytes can be sent straight to it — no driver to install,
no queue to create, nothing about the machine to change. Going through a print
queue instead would mean installing a generic driver and hoping it does not
rescale the image, which on a device with one fixed dot pitch can only make it
worse.
"""

import os

import numpy as np

try:
    import win32file
    import win32con
    import pywintypes
    import win32com.client
    _WIN = True
except Exception:                                    # not on Windows
    _WIN = False

# The usbprint device-interface class. Every USB printer Windows has claimed
# appears under it, whether or not anyone made a print queue for it.
USBPRINT_GUID = "{28d78fad-5a12-11d1-ae5b-0000f803a8c2}"

# 58mm paper, 384 dots across. This is a property of the print head, not a
# setting: sending a wider raster makes the printer discard the overflow, and a
# narrower one simply prints small.
DOTS = 384

# How dark a pixel must be to burn. Thermal paper has no half-tones — a pixel
# is black or it is white — so the threshold decides how heavy the glyphs look.
# High enough that the off-white of an anti-aliased edge stays white.
INK_THRESHOLD = 160

ESC = b"\x1b"
GS = b"\x1d"
INIT = ESC + b"@"                 # reset: clears any half-finished line
FEED_AND_PARK = b"\n" * 4         # clear the tear bar, so the sheet can be torn


def find_printer_path(vid="28E9", pid="0289"):
    """The device path to write to, or None if the printer is not plugged in.

    Looked up rather than hardcoded: the path carries the unit's serial number,
    so a hardcoded one works until someone uses a different printer — which, at
    a competition, means the spare.
    """
    if not _WIN:
        return None
    try:
        wmi = win32com.client.GetObject("winmgmts:")
        for d in wmi.InstancesOf("Win32_PnPEntity"):
            if not d.Service or d.Service.lower() != "usbprint":
                continue
            dev = d.DeviceID or ""
            if vid.upper() not in dev.upper() or pid.upper() not in dev.upper():
                continue
            # USB\VID_28E9&PID_0289\000000000004 -> \\?\usb#vid_28e9&pid_0289#000000000004#{guid}
            return "\\\\?\\" + dev.replace("\\", "#").lower() + "#" + USBPRINT_GUID
    except Exception as e:
        print("thermal: could not enumerate printers:", e)
    return None


def _raster(mono):
    """ESC/POS GS v 0 raster image from a 2-D boolean array (True = burn)."""
    h, w = mono.shape
    width_bytes = (w + 7) // 8
    # Pad to a whole number of bytes so the last few dots of a row are white
    # rather than whatever happened to follow in memory.
    if width_bytes * 8 != w:
        mono = np.hstack([mono, np.zeros((h, width_bytes * 8 - w), bool)])
    packed = np.packbits(mono, axis=1).tobytes()
    header = GS + b"v0" + b"\x00" + bytes([
        width_bytes & 0xFF, (width_bytes >> 8) & 0xFF,
        h & 0xFF, (h >> 8) & 0xFF,
    ])
    return header + packed


def image_to_escpos(path, dots=DOTS, threshold=INK_THRESHOLD):
    """Load an image and turn it into ESC/POS bytes sized for the print head."""
    from PIL import Image

    im = Image.open(path).convert("L")
    # Scale to the head's width, never past it. LANCZOS keeps the curves of the
    # glyphs readable at this size; nearest-neighbour shreds them.
    if im.width != dots:
        h = max(1, round(im.height * dots / im.width))
        im = im.resize((dots, h), Image.LANCZOS)

    a = np.asarray(im)
    mono = a < threshold                    # True where ink should go

    # Trim blank rows top and bottom. The generated sheet has generous margins
    # for a screen; on a roll they are just paper, and this printer's paper is
    # the thing a demo runs out of.
    rows = np.where(mono.any(axis=1))[0]
    if len(rows):
        pad = 8
        mono = mono[max(0, rows[0] - pad):min(mono.shape[0], rows[-1] + 1 + pad)]

    return INIT + _raster(mono) + FEED_AND_PARK


def strip_to_escpos(im, threshold=INK_THRESHOLD):
    """ESC/POS for an image already laid out at the head's width."""
    a = np.asarray(im.convert("L"))
    return INIT + _raster(a < threshold) + FEED_AND_PARK


def print_image(path, label="", glyphs=None):
    """Send Baybayin to the thermal printer. Returns (ok, detail).

    With `glyphs` the word is laid out for the roll — down the paper, large
    enough to read. Without them the image at `path` is scaled to the head's
    width, which is the honest fallback but produces an 8mm-tall strip from a
    sheet drawn for A4.
    """
    if not _WIN:
        return False, "not running on Windows"

    dev = find_printer_path()
    if not dev:
        return False, "thermal printer not found on USB"

    try:
        if glyphs:
            data = strip_to_escpos(compose_strip(label, glyphs))
        else:
            data = image_to_escpos(path)
    except Exception as e:
        return False, f"could not prepare the image: {e}"

    try:
        h = win32file.CreateFile(dev, win32con.GENERIC_WRITE, 0, None,
                                 win32con.OPEN_EXISTING, 0, None)
    except pywintypes.error as e:
        # Busy usually means something else already has it open — another copy
        # of this program, or a print queue someone created for it.
        return False, f"could not open the printer: {e.strerror.strip()}"

    try:
        # Written in chunks: the device stops accepting a very large single
        # write while the head catches up, and the call fails rather than
        # blocking.
        sent = 0
        CHUNK = 4096
        while sent < len(data):
            _, n = win32file.WriteFile(h, data[sent:sent + CHUNK])
            if not n:
                return False, "the printer stopped accepting data"
            sent += n
        return True, f"printed {label or os.path.basename(path)} ({sent} bytes)"
    except pywintypes.error as e:
        return False, f"write failed: {e.strerror.strip()}"
    finally:
        win32file.CloseHandle(h)


# =========================================================
# LAYING OUT A WORD FOR A 48mm ROLL
# =========================================================
# The screen sheet is a wide horizontal strip — sensible on A4, wrong here.
# Squeezed to 384 dots it came out 8mm tall with the syllable labels too small
# to read. A roll is narrow but effectively endless, so the glyphs go DOWN the
# paper instead of across it, big enough to be worth keeping.

# Glyphs per row. Three fits the width at a size that still reads across a
# table; four is legible only close up.
PER_ROW = 3

FONT_DIR = r"C:\Windows\Fonts"


def _font(size, bold=False):
    from PIL import ImageFont
    for name in ([("arialbd.ttf", "arial.ttf")] if bold else [("arial.ttf",)])[0]:
        try:
            return ImageFont.truetype(os.path.join(FONT_DIR, name), size)
        except Exception:
            continue
    from PIL import ImageFont as F
    return F.load_default()


def _glyph_only(im, threshold=INK_THRESHOLD):
    """Crop a glyph image to the character, dropping its printed romanisation.

    Each source glyph carries its own small label underneath. At A4 that reads
    fine; at 13mm it is an illegible smudge sitting above the larger label this
    layout adds, so the same word appears twice and neither is clear.

    The label is always a short tail after a clear blank gap. Anything taller
    than a quarter of the glyph is part of the character — the S carries a
    kudlit below it on its own line, and cropping that would change what the
    glyph says.
    """
    import numpy as np
    a = np.asarray(im)
    ink = a < threshold
    rows = np.where(ink.any(axis=1))[0]
    if not len(rows):
        return im
    top, bottom = int(rows[0]), int(rows[-1])
    profile = ink[top:bottom + 1].sum(axis=1)

    gaps = []
    run = 0
    for idx, v in enumerate(profile):
        if v == 0:
            run += 1
        else:
            if run >= 24:
                gaps.append((idx - run, idx))
            run = 0
    height = bottom - top + 1
    if gaps:
        gap_start, gap_end = gaps[-1]
        tail = height - gap_end
        if 0 < tail < height * 0.25:
            bottom = top + gap_start
    return im.crop((0, top, im.width, bottom + 1))


def compose_strip(word, glyphs, dots=DOTS):
    """Lay a word out for the roll. `glyphs` is [(image_path, label), ...].

    Returns a PIL image `dots` wide, as tall as it needs to be.
    """
    from PIL import Image, ImageDraw

    cell = dots // PER_ROW              # 128 at 384
    glyph_h = 104                       # ~13mm — readable at arm's length
    label_h = 22
    row_h = glyph_h + label_h + 10
    rows = max(1, (len(glyphs) + PER_ROW - 1) // PER_ROW)

    title_h = 46
    height = title_h + rows * row_h + 16
    canvas = Image.new("L", (dots, height), 255)
    draw = ImageDraw.Draw(canvas)

    # The word itself, so whoever takes the strip away knows what it says.
    title = (word or "").upper()
    f_title = _font(30, bold=True)
    tw = draw.textlength(title, font=f_title)
    draw.text(((dots - tw) / 2, 6), title, font=f_title, fill=0)
    draw.line([(24, title_h - 8), (dots - 24, title_h - 8)], fill=0, width=2)

    f_label = _font(17)
    for i, (path, label) in enumerate(glyphs):
        r, c = divmod(i, PER_ROW)
        # Centre a short final row rather than leaving it hanging left.
        in_row = min(PER_ROW, len(glyphs) - r * PER_ROW)
        x0 = (dots - in_row * cell) // 2 + c * cell
        y0 = title_h + r * row_h

        try:
            g = _glyph_only(Image.open(path).convert("L"))
        except Exception:
            continue
        w = max(1, round(g.width * glyph_h / g.height))
        if w > cell - 8:                      # keep it inside its cell
            w = cell - 8
            g = g.resize((w, max(1, round(g.height * w / g.width))), Image.LANCZOS)
        else:
            g = g.resize((w, glyph_h), Image.LANCZOS)
        canvas.paste(g, (x0 + (cell - g.width) // 2, y0 + (glyph_h - g.height) // 2))

        lw = draw.textlength(label, font=f_label)
        draw.text((x0 + (cell - lw) / 2, y0 + glyph_h + 2), label, font=f_label, fill=0)

    return canvas
