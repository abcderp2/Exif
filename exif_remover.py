#!/usr/bin/env python3
"""画像を再保存してメタデータを引き継がないコマンドライン版。"""

from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageOps, ImageSequence


OUTPUT_FORMATS = {
    ".jpg": ("JPEG", ".jpg"),
    ".jpeg": ("JPEG", ".jpeg"),
    ".png": ("PNG", ".png"),
    ".webp": ("WEBP", ".webp"),
    ".gif": ("GIF", ".gif"),
    ".tif": ("TIFF", ".tif"),
    ".tiff": ("TIFF", ".tiff"),
    ".bmp": ("BMP", ".bmp"),
}


def clean_frame(frame: Image.Image) -> Image.Image:
    """EXIFの向きを画素へ反映し、画像情報を持たないコピーを返す。"""

    transposed = ImageOps.exif_transpose(frame)
    has_alpha = transposed.mode in {"RGBA", "LA"} or "transparency" in transposed.info
    mode = "RGBA" if has_alpha else transposed.mode
    cleaned = transposed.convert(mode).copy()
    cleaned.info.clear()
    return cleaned


def flatten_for_jpeg(image: Image.Image) -> Image.Image:
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image.convert("RGB")


def output_definition(input_path: Path, image: Image.Image) -> tuple[str, str]:
    suffix = input_path.suffix.lower()
    if suffix in OUTPUT_FORMATS:
        return OUTPUT_FORMATS[suffix][0], OUTPUT_FORMATS[suffix][1]
    if image.format in {"JPEG", "PNG", "WEBP", "GIF", "TIFF", "BMP"}:
        extension = {
            "JPEG": ".jpg",
            "PNG": ".png",
            "WEBP": ".webp",
            "GIF": ".gif",
            "TIFF": ".tiff",
            "BMP": ".bmp",
        }[image.format]
        return image.format, extension
    return "PNG", ".png"


def make_output_path(input_path: Path, output_dir: Path | None, extension: str) -> Path:
    directory = output_dir if output_dir is not None else input_path.parent
    return directory / f"{input_path.stem}_no_metadata{extension}"


def save_clean_image(input_path: Path, output_path: Path, quality: int) -> None:
    with Image.open(input_path) as source:
        output_format, _ = output_definition(input_path, source)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        frames: list[Image.Image] = []
        durations: list[int] = []
        for frame in ImageSequence.Iterator(source):
            frames.append(clean_frame(frame))
            durations.append(int(frame.info.get("duration", 0) or 0))

        if not frames:
            raise ValueError("画像のフレームを読み込めません")

        if output_format == "JPEG":
            frames = [flatten_for_jpeg(frames[0])]
        elif output_format == "BMP":
            frames = [frames[0].convert("RGB")]
        elif output_format == "GIF":
            frames = [frame.convert("RGBA") for frame in frames]

        save_kwargs: dict[str, object] = {"format": output_format}
        if output_format == "JPEG":
            save_kwargs.update({"quality": quality, "optimize": True, "exif": b""})
        elif output_format == "WEBP":
            save_kwargs.update({"quality": quality, "method": 6, "exif": b"", "xmp": b""})
        elif output_format == "PNG":
            save_kwargs.update({"pnginfo": None})
        elif output_format == "TIFF":
            save_kwargs.update({"tiffinfo": {}})

        if output_format in {"GIF", "WEBP"} and len(frames) > 1:
            save_kwargs.update(
                {
                    "save_all": True,
                    "append_images": frames[1:],
                    "duration": durations,
                    "loop": int(source.info.get("loop", 0) or 0),
                }
            )

        frames[0].save(output_path, **save_kwargs)


def iter_input_paths(arguments: Iterable[str]) -> list[Path]:
    paths: list[Path] = []
    for argument in arguments:
        expanded = glob.glob(argument)
        paths.extend(Path(path) for path in expanded) if expanded else paths.append(Path(argument))
    return paths


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="画像を再保存してExif等のメタデータを除去します")
    parser.add_argument("files", nargs="+", help="入力画像。ワイルドカードも使えます")
    parser.add_argument("--output-dir", type=Path, help="出力先フォルダ。省略時は入力画像と同じフォルダ")
    parser.add_argument("--quality", type=int, choices=range(1, 101), default=96, help="JPEGとWebPの画質。既定値は96")
    parser.add_argument("--overwrite", action="store_true", help="同名の出力ファイルを上書きします")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = iter_input_paths(args.files)
    if not paths:
        print("処理する画像が見つかりません", file=sys.stderr)
        return 2

    success = 0
    for input_path in paths:
        if not input_path.is_file():
            print(f"失敗　ファイルがありません　{input_path}", file=sys.stderr)
            continue
        try:
            with Image.open(input_path) as probe:
                _, extension = output_definition(input_path, probe)
            output_path = make_output_path(input_path, args.output_dir, extension)
            if output_path.resolve() == input_path.resolve():
                raise ValueError("入力と出力が同じです")
            if output_path.exists() and not args.overwrite:
                print(f"スキップ　出力先がすでにあります　{output_path}")
                continue
            save_clean_image(input_path, output_path, args.quality)
            print(f"完了　{input_path}　から　{output_path}")
            success += 1
        except Exception as error:
            print(f"失敗　{input_path}　{error}", file=sys.stderr)

    print(f"処理結果　{success}/{len(paths)}")
    return 0 if success == len(paths) else 1


if __name__ == "__main__":
    raise SystemExit(main())
