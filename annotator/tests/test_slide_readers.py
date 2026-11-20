import openslide
import pyvips
import pytest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from PIL import Image, ImageDraw

from backend.slides import SlidePool, jpeg
from backend.tiff import TiffSlide


@pytest.fixture
def striped_tiff(tmp_path):
    # Odd dimensions exercise edge padding and the original coordinate frame.
    path = tmp_path / "striped.tif"
    image = Image.new("RGB", (4099, 3073), "white")
    draw = ImageDraw.Draw(image)
    for x in range(0, image.width, 17):
        draw.rectangle((x, 0, x + 8, image.height - 1), fill=(x % 256, (x * 7) % 256, 91))
    for y in range(0, image.height, 31):
        draw.line((0, y, image.width - 1, y), fill=(40, y % 256, 210))
    image.save(path, compression="raw")
    return path, image


def test_tiff_fallback_preserves_level_zero_pixels_and_bounds(striped_tiff):
    path, source = striped_tiff
    assert openslide.OpenSlide.detect_format(path) is None
    pool = SlidePool()
    with pool.open(path) as (slide, zoom, _):
        assert isinstance(slide, TiffSlide)
        assert slide.dimensions == source.size
        assert slide.level_dimensions[1] == (2050, 1537)
        region = slide.read_region((1049, 2000), 0, (73, 61))
        assert region.convert("RGB").tobytes() == source.crop((1049, 2000, 1122, 2061)).tobytes()
        edge = slide.read_region((4098, 3072), 0, (3, 3))
        assert edge.getpixel((0, 0)) == (*source.getpixel((4098, 3072)), 255)
        assert edge.getpixel((2, 2))[3] == 0
        assert max(slide.get_thumbnail((240, 160)).size) <= 240
        for level in range(zoom.level_count):
            cols, rows = zoom.level_tiles[level]
            tile = zoom.get_tile(level, (cols - 1, rows - 1))
            assert tile.size == zoom.get_tile_dimensions(level, (cols - 1, rows - 1))
    pool.close()


def test_adjacent_tiff_tiles_share_identical_overlap(striped_tiff):
    path, _ = striped_tiff
    pool = SlidePool()
    with pool.open(path) as (_, zoom, _):
        # Check both streamed levels and cached overview levels.
        for level in (zoom.level_count - 2, zoom.level_count - 3):
            left, right = zoom.get_tile(level, (0, 0)), zoom.get_tile(level, (1, 0))
            assert left.crop((left.width - 2, 0, left.width, left.height)).tobytes() == right.crop((0, 0, 2, right.height)).tobytes()
    pool.close()


def test_native_pyramid_still_uses_openslide(striped_tiff, tmp_path):
    path, source = striped_tiff
    pyramid = tmp_path / "pyramid.tif"
    pyvips.Image.tiffload(str(path)).tiffsave(str(pyramid), tile=True, pyramid=True, compression="deflate")
    pool = SlidePool()
    with pool.open(pyramid) as (slide, zoom, _):
        assert isinstance(slide, openslide.OpenSlide)
        assert slide.dimensions == source.size
        assert zoom.get_tile(zoom.level_count - 1, (0, 0)).size == (255, 255)
    pool.close()


def test_active_reader_is_not_evicted(striped_tiff, tmp_path):
    path, _ = striped_tiff
    other = tmp_path / "other.tif"
    Image.new("RGB", (128, 128), "red").save(other)
    pool = SlidePool(limit=1)
    with pool.open(path) as (active, _, _):
        with pool.open(other):
            assert active.read_region((0, 0), 0, (10, 10)).size == (10, 10)
        assert active.read_region((0, 0), 0, (10, 10)).size == (10, 10)
    pool.close()
    with pytest.raises(openslide.OpenSlideError, match="closed"):
        active.read_region((0, 0), 0, (10, 10))


def test_unsupported_tiff_does_not_silently_choose_a_page(tmp_path):
    path = tmp_path / "multipage.tif"
    image = Image.new("RGB", (100, 100), "white")
    image.save(path, save_all=True, append_images=[image])
    with pytest.raises(openslide.OpenSlideUnsupportedFormatError, match="multiple pages"):
        with SlidePool().open(path):
            pass


def test_unavailable_thumbnail_cache_does_not_prevent_viewing(tmp_path):
    path = tmp_path / "slide.tif"
    Image.new("RGB", (100, 100), "red").save(path)
    blocked = tmp_path / "cache"
    blocked.write_text("A file occupies the cache directory path")
    pool = SlidePool(thumbnail_cache=blocked)
    with pool.open(path) as (slide, zoom, _):
        assert slide.cached_thumbnail() is None
        assert zoom.get_tile(zoom.level_count - 1, (0, 0)).getpixel((0, 0)) == (255, 0, 0)
    pool.close()


@pytest.mark.parametrize("reader", ["native", "tiff"])
def test_tiles_read_concurrently_and_close_waits_for_readers(striped_tiff, tmp_path, monkeypatch, reader):
    path, _ = striped_tiff
    if reader == "native":
        pyramid = tmp_path / "pyramid.tif"
        pyvips.Image.tiffload(str(path)).tiffsave(str(pyramid), tile=True, pyramid=True, compression="deflate")
        path = pyramid
    pool = SlidePool()
    with pool.open(path) as (slide, zoom, transform):
        level = zoom.level_count - 1
        expected = [jpeg(zoom.get_tile(level, (col, 0)), transform) for col in (0, 1)]
    both_reading = Barrier(3)
    release, closed = Event(), Event()
    read_region, close = slide.read_region, slide.close

    def held_read(*args):
        both_reading.wait(timeout=5)
        assert release.wait(5)
        assert not closed.is_set()
        return read_region(*args)

    def tracked_close():
        closed.set()
        close()

    monkeypatch.setattr(slide, "read_region", held_read)
    monkeypatch.setattr(slide, "close", tracked_close)
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = [workers.submit(pool.tile, path, level, col, 0) for col in (0, 1)]
        try:
            both_reading.wait(timeout=5)
            pool.close()
            assert not closed.is_set()
        finally:
            release.set()
        assert [result.result(timeout=5) for result in results] == expected
    assert closed.is_set()
    assert not pool.handles
    assert pool.tiles.size == 0


def test_concurrent_tiff_overview_tiles_build_one_overview(striped_tiff, monkeypatch):
    path, _ = striped_tiff
    pool = SlidePool()
    with pool.open(path) as (slide, zoom, _):
        level = zoom.level_count - 1 - slide._overview_level
        read_pixels = slide._read_pixels
    calls = []
    start = Barrier(2)

    def tracked_read(*args):
        calls.append(1)
        return read_pixels(*args)

    def read_tile(col):
        start.wait(timeout=5)
        return pool.tile(path, level, col, 0)

    monkeypatch.setattr(slide, "_read_pixels", tracked_read)
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(read_tile, (0, 1)))
    assert all(data.startswith(b"\xff\xd8") for data in results)
    assert calls == [1]
    pool.close()


def test_rendered_tiles_reused_across_handle_eviction_and_invalidated_on_change(tmp_path, monkeypatch):
    path, other = tmp_path / "one.tif", tmp_path / "two.tif"
    Image.new("RGB", (100, 100), "red").save(path)
    Image.new("RGB", (100, 100), "blue").save(other)
    pool = SlidePool(limit=1)
    red = pool.tile(path, 7, 0, 0)
    with pool.open(other):
        pass
    original = TiffSlide.read_region
    monkeypatch.setattr(TiffSlide, "read_region", lambda *args: pytest.fail("Cached tile was decoded again"))
    assert pool.tile(path, 7, 0, 0) == red
    monkeypatch.setattr(TiffSlide, "read_region", original)
    Image.new("RGB", (101, 100), "blue").save(path)
    assert pool.tile(path, 7, 0, 0) != red
    pool.close()
