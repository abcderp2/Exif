#!/usr/bin/env python3
"""画像を再保存してメタデータを引き継がないコマンドライン版。"""

from __future__ import annotations

import argparse
import glob
import sys
import warnings
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator

try:
    from PIL import Image, ImageOps, ImageSequence
except ImportError:  # Pillow is optional for the browser-only use case.
    Image = ImageOps = ImageSequence = None


MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_SOURCE_DIMENSION = 8192
MAX_SOURCE_PIXELS = 32_000_000
MAX_FRAMES = 120
MAX_TOTAL_FRAME_PIXELS = 32_000_000

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


def require_pillow() -> None:
    if Image is None or ImageOps is None or ImageSequence is None:
        raise RuntimeError("このコマンドにはPillowが必要です。Pillowをインストールしてから実行してください")


def source_frame_count(source: Image.Image) -> int:
    try:
        frame_count = int(getattr(source, "n_frames", 1))
    except (TypeError, ValueError) as error:
        raise ValueError("画像のフレーム数を確認できません") from error
    if frame_count < 1:
        raise ValueError("画像のフレーム数が不正です")
    return frame_count


def validate_source_limits(source: Image.Image) -> tuple[int, int, int]:
    """Pillowが完全復号する前に、ヘッダー由来の値を安全上限と照合する。"""

    try:
        width, height = source.size
        width = int(width)
        height = int(height)
    except (TypeError, ValueError) as error:
        raise ValueError("画像の大きさを確認できません") from error
    if width < 1 or height < 1:
        raise ValueError("画像の大きさが不正です")
    if width > MAX_SOURCE_DIMENSION or height > MAX_SOURCE_DIMENSION:
        raise ValueError(f"画像の縦横が上限{MAX_SOURCE_DIMENSION}pxを超えています")

    pixels = width * height
    if pixels > MAX_SOURCE_PIXELS:
        raise ValueError(f"画像の総画素数が上限{MAX_SOURCE_PIXELS:,}を超えています")

    frame_count = source_frame_count(source)
    if frame_count > MAX_FRAMES:
        raise ValueError(f"アニメーションのフレーム数が上限{MAX_FRAMES}を超えています")
    if pixels * frame_count > MAX_TOTAL_FRAME_PIXELS:
        raise ValueError(f"アニメーションを含む総画素数が上限{MAX_TOTAL_FRAME_PIXELS:,}を超えています")
    return width, height, frame_count


@contextmanager
def open_checked_image(input_path: Path) -> Iterator[Image.Image]:
    """入力サイズ、PillowのBomb判定、ヘッダー値を確認してから画像を開く。"""

    require_pillow()
    if input_path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError(f"入力ファイルが上限{MAX_INPUT_BYTES // (1024 * 1024)}MBを超えています")

    previous_max_pixels = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_SOURCE_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(input_path) as source:
                validate_source_limits(source)
                yield source
    finally:
        Image.MAX_IMAGE_PIXELS = previous_max_pixels


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


def frame_durations(source: Image.Image, expected_frames: int) -> list[int]:
    durations: list[int] = []
    for index, frame in enumerate(ImageSequence.Iterator(source), start=1):
        if index > MAX_FRAMES:
            raise ValueError(f"アニメーションのフレーム数が上限{MAX_FRAMES}を超えています")
        durations.append(int(frame.info.get("duration", 0) or 0))
    if len(durations) != expected_frames:
        raise ValueError("アニメーションのフレーム数を一貫して確認できません")
    source.seek(0)
    return durations


def cleaned_frames(source: Image.Image) -> Iterator[Image.Image]:
    for index, frame in enumerate(ImageSequence.Iterator(source), start=1):
        if index > MAX_FRAMES:
            raise ValueError(f"アニメーションのフレーム数が上限{MAX_FRAMES}を超えています")
        yield clean_frame(frame)


def prepare_frame_for_output(frame: Image.Image, output_format: str) -> Image.Image:
    if output_format == "JPEG":
        return flatten_for_jpeg(frame)
    if output_format == "BMP":
        return frame.convert("RGB")
    if output_format == "GIF":
        return frame.convert("RGBA")
    return frame


def save_clean_image(input_path: Path, output_path: Path, quality: int) -> None:
    with open_checked_image(input_path) as source:
        output_format, _ = output_definition(input_path, source)
        frame_count = source_frame_count(source)
        preserve_animation = output_format in {"GIF", "WEBP"} and frame_count > 1
        durations = frame_durations(source, frame_count) if preserve_animation else []
        frames = cleaned_frames(source)
        try:
            first_frame = next(frames)
        except StopIteration as error:
            raise ValueError("画像のフレームを読み込めません") from error
        first_frame = prepare_frame_for_output(first_frame, output_format)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        save_kwargs: dict[str, object] = {"format": output_format}
        if output_format == "JPEG":
            save_kwargs.update({"quality": quality, "optimize": True, "exif": b""})
        elif output_format == "WEBP":
            save_kwargs.update({"quality": quality, "method": 6, "exif": b"", "xmp": b""})
        elif output_format == "PNG":
            save_kwargs.update({"pnginfo": None})
        elif output_format == "TIFF":
            save_kwargs.update({"tiffinfo": {}})

        if preserve_animation:
            save_kwargs.update(
                {
                    "save_all": True,
                    "append_images": (prepare_frame_for_output(frame, output_format) for frame in frames),
                    "duration": durations,
                    "loop": int(source.info.get("loop", 0) or 0),
                }
            )

        first_frame.save(output_path, **save_kwargs)


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
    try:
        require_pillow()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 2

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
            with open_checked_image(input_path) as probe:
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
