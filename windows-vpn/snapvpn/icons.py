"""App and tray icons, drawn with Pillow so no image files are needed."""

from PIL import Image, ImageDraw

ACCENT = (59, 130, 246)       # blue
STATUS_COLORS = {
    "connected": (34, 197, 94),     # green
    "busy": (245, 158, 11),         # amber
    "disconnected": (107, 114, 128),  # grey
    "error": (239, 68, 68),         # red
}


def _shield(draw: ImageDraw.ImageDraw, s: int, fill) -> None:
    """A symmetric shield shape filling most of an s x s canvas."""
    cx = s / 2
    half = s * 0.39
    top = s * 0.06
    shoulder = s * 0.17
    mid = s * 0.50
    bottom = s * 0.95
    right = [(cx, top), (cx + half * 0.55, top + s * 0.05), (cx + half, shoulder), (cx + half, mid)]
    steps = 16
    for i in range(1, steps + 1):
        t = i / steps
        # Ease from the straight side into the bottom point.
        x = cx + half * (1 - t) ** 1.25
        y = mid + (bottom - mid) * (1 - (1 - t) ** 1.8)
        right.append((x, y))
    left = [(2 * cx - x, y) for x, y in reversed(right[1:-1])]
    draw.polygon(right + left, fill=fill)


def _keyhole(draw: ImageDraw.ImageDraw, s: int, fill) -> None:
    cx = s / 2
    r = s * 0.1
    cy = s * 0.43
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)
    draw.polygon([(cx - r * 0.55, cy), (cx + r * 0.55, cy), (cx + r * 0.9, s * 0.7), (cx - r * 0.9, s * 0.7)], fill=fill)


def make_icon(size: int = 256, status: str | None = None) -> Image.Image:
    """Shield logo; with `status`, the shield is coloured by connection state."""
    scale = 4  # supersample for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = ACCENT if status is None else STATUS_COLORS.get(status, ACCENT)
    _shield(d, s, color)
    _keyhole(d, s, (255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def save_ico(path: str) -> None:
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    make_icon(256).save(path, format="ICO", sizes=[(n, n) for n in sizes])
