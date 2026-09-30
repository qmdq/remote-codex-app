from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


OUT_DIR = Path("static/brand")
RENDER_SCALE = 4
FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/arialbd.ttf"),
    Path("C:/Windows/Fonts/ArialBD.TTF"),
    Path("C:/Windows/Fonts/segoeuib.ttf"),
    Path("C:/Windows/Fonts/SegoeUIBold.ttf"),
]


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def vertical_gradient(width: int, height: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    source = Image.linear_gradient("L").resize((width, height), Image.Resampling.BICUBIC)
    channels = []
    for index in range(3):
        low, high = top[index], bottom[index]
        channels.append(source.point(lambda value, a=low, b=high: round(a + (b - a) * value / 255)))
    return Image.merge("RGB", channels)


def draw_brand_tile(size: int) -> Image.Image:
    render = size * RENDER_SCALE
    canvas = Image.new("RGBA", (render, render), (0, 0, 0, 0))
    gradient = vertical_gradient(render, render, (232, 112, 58), (180, 92, 240)).convert("RGBA")
    radius = round(render * 0.43)
    canvas.paste(gradient, (0, 0), rounded_mask(render, radius))

    unit = render / 72
    line_width = max(1, round(unit * 4.6))
    white = (255, 255, 255, 246)
    draw = ImageDraw.Draw(canvas)
    box = lambda x1, y1, x2, y2: (round(x1 * unit), round(y1 * unit), round(x2 * unit), round(y2 * unit))
    half = line_width / 2

    def cap(x: float, y: float):
        draw.ellipse((x * unit - half, y * unit - half, x * unit + half, y * unit + half), fill=white)

    def stroke(points: list[tuple[float, float]]):
        coords = [(x * unit, y * unit) for x, y in points]
        draw.line(coords, fill=white, width=line_width, joint="curve")
        cap(*points[0])
        cap(*points[-1])

    draw.rounded_rectangle(box(17, 17, 55, 42), radius=round(unit * 8), outline=white, width=line_width)
    stroke([(25, 25), (31, 30), (25, 35)])
    draw.rounded_rectangle(box(36, 34, 47, 38), radius=round(line_width / 2), fill=white)
    stroke([(36, 42), (36, 50)])
    draw.rounded_rectangle(box(28, 50, 44, 54), radius=round(line_width / 2), fill=white)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def base_canvas(size: int, palette: dict) -> Image.Image:
    render = size * RENDER_SCALE
    background = vertical_gradient(render, render, palette["top"], palette["bottom"]).convert("RGBA")
    glow = Image.new("RGBA", (render, render), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    draw.ellipse((render * -0.20, render * -0.32, render * 0.80, render * 0.20), fill=(232, 112, 58, 50))
    draw.ellipse((render * 0.32, render * 0.74, render * 1.28, render * 1.46), fill=(56, 189, 248, 34))
    glow = glow.filter(ImageFilter.GaussianBlur(render * 0.085))
    return Image.alpha_composite(background, glow)


def draw_background_logo(size: int, palette: dict, rounded_ratio: float | None) -> Image.Image:
    render = size * RENDER_SCALE
    canvas = base_canvas(size, palette)
    draw = ImageDraw.Draw(canvas)
    center = render / 2
    tile_radius = render * 0.315
    border_box = (center - tile_radius, center - tile_radius, center + tile_radius, center + tile_radius)
    draw.rounded_rectangle(
        border_box,
        radius=round(tile_radius * 0.43),
        outline=(255, 255, 255, 52),
        width=max(2, round(render * 0.004)),
    )
    tile_size = round(tile_radius * 2 - render * 0.018)
    tile = draw_brand_tile(tile_size)
    tile_position = round(center - tile_size / 2)
    canvas.paste(tile, (tile_position, tile_position), tile)
    output = canvas.resize((size, size), Image.Resampling.LANCZOS)
    if rounded_ratio is None:
        return output
    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(output, (0, 0), rounded_mask(size, round(size * rounded_ratio)))
    return result


def draw_transparent_logo(size: int) -> Image.Image:
    return draw_brand_tile(size)


def draw_splash(size: int, palette: dict) -> Image.Image:
    canvas = base_canvas(size, palette)
    render = size * RENDER_SCALE
    tile_size = round(render * 0.235)
    tile = draw_transparent_logo(tile_size)
    position = (round((render - tile_size) / 2), round(render * 0.345))
    canvas.paste(tile, position, tile)
    add_title(canvas, "RemoteCodex", "Mobile Codex Agent", palette)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def save_rgb(image: Image.Image, path: Path):
    image.convert("RGB").save(path, optimize=True)


def load_font(size: int):
    for path in FONT_CANDIDATES:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()




def add_title(image: Image.Image, title: str, subtitle: str, palette: dict[str, str]):
    width, height = image.size
    scale = max(1, width // 720)
    title_font = load_font(46 * scale)
    subtitle_font = load_font(24 * scale)
    draw = ImageDraw.Draw(image)
    title_y = round(height * 0.674)
    draw.text((width / 2, title_y), title, font=title_font, fill=palette["title"], anchor="mm")
    draw.text((width / 2, title_y + 58 * scale), subtitle, font=subtitle_font, fill=palette["subtitle"], anchor="mm")
    return image


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dark = {
        "top": (10, 15, 28),
        "bottom": (4, 6, 12),
        "title": (245, 248, 255),
        "subtitle": (160, 172, 192),
    }
    light = {
        "top": (253, 254, 255),
        "bottom": (232, 238, 248),
        "title": (24, 34, 51),
        "subtitle": (96, 108, 126),
    }
    draw_background_logo(1024, dark, 0.22).save(OUT_DIR / "logo-1024.png", optimize=True)
    draw_transparent_logo(512).save(OUT_DIR / "logo-512.png", optimize=True)
    save_rgb(draw_background_logo(1024, dark, None), OUT_DIR / "app-icon-1024.png")
    for filename, palette in [
        ("splash-dark.png", dark),
        ("splash-light.png", light),
    ]:
        draw_splash(1536, palette).save(OUT_DIR / filename, optimize=True)
    for size in [192, 144, 96, 72, 48]:
        save_rgb(draw_background_logo(size, dark, None), OUT_DIR / f"icon-{size}.png")


if __name__ == "__main__":
    main()
