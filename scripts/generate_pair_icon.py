from pathlib import Path

from PIL import Image, ImageDraw


SCALE = 4
SIZE = 81
COLORS = {
    "": "#7e879c",
    "-active": "#f0a06a",
}


for suffix, color in COLORS.items():
    canvas = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    width = 5 * SCALE
    draw.arc((15 * SCALE, 15 * SCALE, 66 * SCALE, 66 * SCALE), 250, 470, fill=color, width=width)
    draw.arc((26 * SCALE, 26 * SCALE, 55 * SCALE, 55 * SCALE), 250, 470, fill=color, width=width)
    draw.line(((20 * SCALE, 30 * SCALE), (61 * SCALE, 30 * SCALE)), fill=color, width=width, joint="curve")
    draw.line(((20 * SCALE, 42 * SCALE), (61 * SCALE, 42 * SCALE)), fill=color, width=width, joint="curve")
    draw.line(((26 * SCALE, 54 * SCALE), (55 * SCALE, 54 * SCALE)), fill=color, width=width, joint="curve")
    image = canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    image.save(Path("static") / f"pair{suffix}.png")
