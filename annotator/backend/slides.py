from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from io import BytesIO
from threading import RLock

import openslide
from openslide.deepzoom import DeepZoomGenerator
from PIL import ImageCms

from .tiff import TiffSlide
from .tile_cache import TileCache


@dataclass
class SlideHandle:
    slide: openslide.AbstractSlide
    zoom: DeepZoomGenerator
    transform: object
    users: int = 0
    failed: bool = False
    retiring: bool = False


class SlidePool:
    """Bounded idle handles; active reads pin their handle against eviction."""
    def __init__(self, limit=6, thumbnail_cache=None, tile_cache_bytes=64 * 1024 * 1024):
        self.limit = limit
        self.thumbnail_cache = thumbnail_cache
        self.lock = RLock()
        self.handles = OrderedDict()
        self.cache = openslide.OpenSlideCache(128 * 1024 * 1024)
        self.tiles = TileCache(tile_cache_bytes)

    @contextmanager
    def open(self, path):
        with self.lock:
            stat = path.stat()
            key = (str(path), stat.st_size, stat.st_mtime_ns)
            if key not in self.handles:
                try:
                    slide = openslide.OpenSlide(path)
                except openslide.OpenSlideUnsupportedFormatError:
                    if path.suffix.lower() not in {".tif", ".tiff"}:
                        raise
                    slide = TiffSlide(path, thumbnail_cache=self.thumbnail_cache)
                slide.set_cache(self.cache)
                transform = None
                try:
                    if slide.color_profile:
                        # Disable LittleCMS's mutable one-pixel cache so this
                        # transform can be shared by concurrent tile requests.
                        transform = ImageCms.buildTransform(slide.color_profile, ImageCms.createProfile("sRGB"), "RGBA", "RGBA", flags=ImageCms.Flags.NOCACHE)
                    zoom = DeepZoomGenerator(slide, tile_size=254, overlap=1, limit_bounds=False)
                except Exception:
                    slide.close()
                    raise
                self.handles[key] = SlideHandle(slide, zoom, transform)
            handle = self.handles[key]
            handle.users += 1
            self.handles.move_to_end(key)
            self._evict()
        try:
            # Readers support concurrent regions; TIFF bounds its own streams
            # and synchronizes overview construction. Pin the handle until all
            # requests finish so close() never races with an active read.
            with self.lock:
                if handle.failed:
                    raise openslide.OpenSlideError("Slide reader failed; retry opening the slide")
            try:
                yield handle.slide, handle.zoom, handle.transform
            except openslide.OpenSlideError:
                with self.lock:
                    handle.failed = True
                raise
        finally:
            with self.lock:
                handle.users -= 1
                self._evict()

    def _evict(self):
        for key, handle in list(self.handles.items()):
            if handle.users == 0 and (handle.failed or handle.retiring or len(self.handles) > self.limit):
                self.handles.pop(key)
                handle.slide.close()

    def close(self):
        with self.lock:
            for handle in self.handles.values():
                handle.retiring = True
            self._evict()
            self.tiles.clear()

    def tile(self, path, level, col, row):
        stat = path.stat()
        key = (str(path), stat.st_size, stat.st_mtime_ns, level, col, row)

        def render():
            with self.open(path) as (_, zoom, transform):
                if not 0 <= level < zoom.level_count:
                    raise ValueError("Invalid tile level")
                cols, rows = zoom.level_tiles[level]
                if not (0 <= col < cols and 0 <= row < rows):
                    raise ValueError("Invalid tile coordinates")
                return jpeg(zoom.get_tile(level, (col, row)), transform)

        return self.tiles.get_or_create(key, render)


def jpeg(image, transform=None):
    if transform:
        image = ImageCms.applyTransform(image.convert("RGBA"), transform)
    buffer = BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=88)
    return buffer.getvalue()
