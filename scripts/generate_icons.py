from pathlib import Path

from PIL import Image, ImageDraw


SIZE = 81
SCALE = 4
NORMAL = "#7e879c"
ACTIVE = "#f0a06a"


def add_lines(draw: ImageDraw.ImageDraw, lines, color):
    for line in lines:
        draw.line(line, fill=color, width=5 * SCALE, joint="curve")


ICONS = {
    "projects": lambda draw, color: (
        draw.rounded_rectangle(
            (10 * SCALE, 19 * SCALE, 67 * SCALE, 64 * SCALE),
            radius=9 * SCALE,
            outline=color,
            width=5 * SCALE,
        ),
        add_lines(draw, [((10 * SCALE, 36 * SCALE), (67 * SCALE, 36 * SCALE))], color),
        draw.rounded_rectangle(
            (19 * SCALE, 13 * SCALE, 48 * SCALE, 25 * SCALE),
            radius=5 * SCALE,
            outline=color,
            width=5 * SCALE,
        ),
    ),
    "task": lambda draw, color: (
        draw.rounded_rectangle(
            (11 * SCALE, 13 * SCALE, 70 * SCALE, 58 * SCALE),
            radius=13 * SCALE,
            outline=color,
            width=5 * SCALE,
        ),
        add_lines(
            draw,
            [
                ((24 * SCALE, 29 * SCALE), (57 * SCALE, 29 * SCALE)),
                ((24 * SCALE, 42 * SCALE), (44 * SCALE, 42 * SCALE)),
                ((26 * SCALE, 58 * SCALE), (20 * SCALE, 68 * SCALE)),
            ],
            color,
        ),
    ),
    "events": lambda draw, color: add_lines(
        draw,
        [
            ((13 * SCALE, 18 * SCALE), (68 * SCALE, 18 * SCALE)),
            ((13 * SCALE, 31 * SCALE), (68 * SCALE, 31 * SCALE)),
            ((13 * SCALE, 44 * SCALE), (48 * SCALE, 44 * SCALE)),
            ((13 * SCALE, 57 * SCALE), (68 * SCALE, 57 * SCALE)),
            ((13 * SCALE, 68 * SCALE), (38 * SCALE, 68 * SCALE)),
        ],
        color,
    ),
    "monitor": lambda draw, color: (
        draw.rounded_rectangle(
            (12 * SCALE, 13 * SCALE, 69 * SCALE, 68 * SCALE),
            radius=10 * SCALE,
            outline=color,
            width=5 * SCALE,
        ),
        add_lines(
            draw,
            [
                ((12 * SCALE, 40 * SCALE), (69 * SCALE, 40 * SCALE)),
                ((40 * SCALE, 13 * SCALE), (40 * SCALE, 68 * SCALE)),
            ],
            color,
        ),
    ),
    "settings": lambda draw, color: (
        add_lines(
            draw,
            [
                ((13 * SCALE, 20 * SCALE), (68 * SCALE, 20 * SCALE)),
                ((13 * SCALE, 40 * SCALE), (68 * SCALE, 40 * SCALE)),
                ((13 * SCALE, 61 * SCALE), (68 * SCALE, 61 * SCALE)),
            ],
            color,
        ),
        draw.ellipse((33 * SCALE, 13 * SCALE, 47 * SCALE, 27 * SCALE), fill="#05070d", outline=color, width=5 * SCALE),
        draw.ellipse((20 * SCALE, 33 * SCALE, 34 * SCALE, 47 * SCALE), fill="#05070d", outline=color, width=5 * SCALE),
        draw.ellipse((42 * SCALE, 54 * SCALE, 56 * SCALE, 68 * SCALE), fill="#05070d", outline=color, width=5 * SCALE),
    ),
}


def render(name, painter, color, suffix):
    image = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    painter(draw, color)
    image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    image.save(Path("static") / f"{name}{suffix}.png")


for icon_name, painter in ICONS.items():
    render(icon_name, painter, NORMAL, "")
    render(icon_name, painter, ACTIVE, "-active")
