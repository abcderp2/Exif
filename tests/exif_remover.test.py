#!/usr/bin/env python3
"""exif_remover.pyの復号前制限に対する回帰テスト。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import exif_remover  # noqa: E402


class FakeImage:
    def __init__(self, size: tuple[int, int], frame_count: int = 1) -> None:
        self.size = size
        self.n_frames = frame_count


class SourceLimitTests(unittest.TestCase):
    def test_accepts_bounded_source(self) -> None:
        self.assertEqual(exif_remover.validate_source_limits(FakeImage((4000, 3000))), (4000, 3000, 1))

    def test_rejects_dimension_and_pixel_limits(self) -> None:
        with self.assertRaisesRegex(ValueError, "縦横"):
            exif_remover.validate_source_limits(FakeImage((8193, 1)))
        with self.assertRaisesRegex(ValueError, "総画素数"):
            exif_remover.validate_source_limits(FakeImage((8000, 5000)))

    def test_rejects_frame_and_total_pixel_limits(self) -> None:
        with self.assertRaisesRegex(ValueError, "フレーム数"):
            exif_remover.validate_source_limits(FakeImage((100, 100), exif_remover.MAX_FRAMES + 1))
        with self.assertRaisesRegex(ValueError, "総画素数"):
            exif_remover.validate_source_limits(FakeImage((2000, 1000), 17))


if __name__ == "__main__":
    unittest.main()
