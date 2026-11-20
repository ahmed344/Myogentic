"""Bounded, region-based access to ordinary RGB TIFFs unsupported by OpenSlide."""

import math
import os
import hashlib
import uuid
from contextlib import suppress
from pathlib import Path
from threading import BoundedSemaphore, RLock

# Large-core workstations otherwise allocate a strip buffer per libvips worker.
# Set before importing the bundled library. Two streams may run concurrently.
os.environ.setdefault("VIPS_CONCURRENCY", "2")

import openslide
import pyvips
from PIL import Image
from .calibration import ome_calibration

# Each read uses a fresh sequential pipeline; retaining old operations keeps file
# mappings and pixel buffers alive. OpenSlide has its own independent tile cache.
pyvips.cache_set_max(0)
_streams = BoundedSemaphore(2)


class TiffSlide(openslide.AbstractSlide):
    """Expose virtual power-of-two levels through OpenSlide's reader contract.

    Only a small overview is retained. Finer levels crop the required source
    region and stream its reduction with libvips. Never decode a full-resolution
    TIFF into a Pillow image, and never modify or convert the original on disk.
    """

    def __init__(self, path: Path, thumbnail_cache: Path | None = None):
        super().__init__()
        self.path = path
        self._overviews: dict[int, Image.Image] = {}
        self._overview_lock = RLock()
        self._closed = False
        self._thumbnail_path = None
        if thumbnail_cache is not None:
            stat = path.stat()
            key = hashlib.sha256(f"{path}\0{stat.st_size}\0{stat.st_mtime_ns}".encode()).hexdigest()
            self._thumbnail_path = thumbnail_cache / f"{key}.png"
        try:
            image = self._source()
            if image.get("n-pages") != 1:
                raise openslide.OpenSlideUnsupportedFormatError(
                    "This TIFF contains multiple pages; select or convert the intended image first."
                )
            if image.format != "uchar" or image.bands not in (3, 4) or image.interpretation not in ("srgb", "rgb"):
                raise openslide.OpenSlideUnsupportedFormatError(
                    "The TIFF reader currently supports single-page, 8-bit RGB/RGBA images."
                )
            width, height = image.width, image.height
            self._properties = {openslide.PROPERTY_NAME_VENDOR: "generic-tiff", "myogentic.reader": "libvips"}
            if image.get_typeof("image-description"):
                self._properties.update(ome_calibration(image.get("image-description"), (width, height)))
            count = math.ceil(math.log2(max(width, height))) + 1
            self._downsamples = tuple(2**level for level in range(count))
            self._dimensions = tuple((math.ceil(width / d), math.ceil(height / d)) for d in self._downsamples)
            self._overview_level = max(0, math.ceil(math.log2(max(width, height) / 2048)))
            if image.get_typeof("icc-profile-data"):
                self._profile = bytes(image.get("icc-profile-data"))
        except pyvips.Error as exc:
            raise openslide.OpenSlideUnsupportedFormatError(f"TIFF metadata could not be read: {exc}") from exc

    def _source(self):
        # Explicit tiffload avoids dispatch to another loader. Preserve the raw
        # pixel orientation so evidence coordinates always refer to the original.
        return pyvips.Image.tiffload(str(self.path), access="sequential", autorotate=False, fail_on="error")

    @classmethod
    def detect_format(cls, filename):
        try:
            pyvips.Image.tiffload(str(filename), access="sequential", autorotate=False)
            return "generic-tiff"
        except pyvips.Error:
            return None

    @property
    def level_count(self):
        return len(self._dimensions)

    @property
    def level_dimensions(self):
        return self._dimensions

    @property
    def level_downsamples(self):
        return self._downsamples

    @property
    def properties(self):
        return self._properties

    @property
    def associated_images(self):
        return {}

    def get_best_level_for_downsample(self, downsample):
        return min(self.level_count - 1, max(0, math.floor(math.log2(max(1, downsample)))))

    def _read_pixels(self, x, y, level, width, height):
        """Return just the requested level pixels, with filter support at edges."""
        factor = self._downsamples[level]
        # Include Lanczos support on all sides so neighbouring tiles agree.
        border = 3 if level else 0
        left, top = max(0, (x - border) * factor), max(0, (y - border) * factor)
        right = min(self.dimensions[0], (x + width + border) * factor)
        bottom = min(self.dimensions[1], (y + height + border) * factor)
        image = self._source().crop(left, top, right - left, bottom - top)
        if level:
            # Pad only at the true image edge, preserving exactly 2**level pixel
            # spacing even when the original dimensions are odd.
            padded_width = math.ceil(image.width / factor) * factor
            padded_height = math.ceil(image.height / factor) * factor
            image = image.embed(0, 0, padded_width, padded_height, extend="copy")
            image = image.resize(1 / factor, kernel="lanczos3")
        image = image.crop(x - left // factor, y - top // factor, width, height)
        mode = "RGBA" if image.bands == 4 else "RGB"
        return Image.frombytes(mode, (width, height), image.write_to_memory()).convert("RGBA")

    def _overview(self, level):
        # Only overview construction shares mutable state. Fine region reads
        # use independent pipelines and may overlap within the two-stream cap.
        with self._overview_lock:
            if level not in self._overviews:
                if level == self._overview_level:
                    width, height = self._dimensions[level]
                    self._overviews[level] = self._read_pixels(0, 0, level, width, height)
                    self._cache_thumbnail(self._overviews[level])
                else:
                    # Integer reduction retains the level-0 coordinate mapping.
                    self._overviews[level] = self._overview(level - 1).reduce(2)
            return self._overviews[level]

    def cached_thumbnail(self):
        """A library preview must never trigger a scan of a multi-GB TIFF."""
        if self._overview_level in self._overviews:
            thumbnail = self._overviews[self._overview_level].copy()
            thumbnail.thumbnail((240, 160))
            return thumbnail
        if self._thumbnail_path is not None and self._thumbnail_path.exists():
            try:
                with Image.open(self._thumbnail_path) as image:
                    if image.width <= 240 and image.height <= 160:
                        return image.convert("RGBA")
            except OSError:
                pass
        return None

    def _cache_thumbnail(self, overview):
        if self._thumbnail_path is None:
            return
        temporary = self._thumbnail_path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        try:
            self._thumbnail_path.parent.mkdir(parents=True, exist_ok=True)
            thumbnail = overview.copy()
            thumbnail.thumbnail((240, 160))
            thumbnail.save(temporary, format="PNG")
            temporary.replace(self._thumbnail_path)
        except OSError:
            # Cache availability must not determine whether a slide can be read.
            pass
        finally:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)

    def read_region(self, location, level, size):
        if self._closed:
            raise openslide.OpenSlideError("The TIFF reader is closed")
        if not 0 <= level < self.level_count or min(size) < 0:
            raise openslide.OpenSlideError("Invalid TIFF region")
        if size[0] * size[1] > 2048 * 2048:
            raise openslide.OpenSlideError("Requested TIFF region is too large; use a lower-resolution level")
        result = Image.new("RGBA", size)
        factor = self._downsamples[level]
        x, y = math.floor(location[0] / factor), math.floor(location[1] / factor)
        left, top = max(0, x), max(0, y)
        right = min(self._dimensions[level][0], x + size[0])
        bottom = min(self._dimensions[level][1], y + size[1])
        if right > left and bottom > top:
            try:
                with _streams:
                    if level >= self._overview_level:
                        pixels = self._overview(level).crop((left, top, right, bottom))
                    else:
                        pixels = self._read_pixels(left, top, level, right - left, bottom - top)
                result.paste(pixels, (left - x, top - y))
            except pyvips.Error as exc:
                raise openslide.OpenSlideError(f"TIFF pixels could not be read: {exc}") from exc
        if self._profile:
            result.info["icc_profile"] = self._profile
        return result

    def close(self):
        for overview in self._overviews.values():
            overview.close()
        self._overviews.clear()
        self._closed = True
