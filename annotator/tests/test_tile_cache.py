from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from backend.tile_cache import TileCache


def test_cache_is_byte_bounded_and_evicts_least_recent_tile():
    cache = TileCache(max_bytes=6)
    assert cache.get_or_create("a", lambda: b"aaa") == b"aaa"
    cache.get_or_create("b", lambda: b"bb")
    assert cache.get_or_create("a", lambda: pytest.fail("Cache miss")) == b"aaa"
    cache.get_or_create("c", lambda: b"ccc")
    assert cache.size == 6
    cache.get_or_create("a", lambda: pytest.fail("Recently used tile evicted"))
    calls = []
    cache.get_or_create("b", lambda: calls.append("render") or b"bb")
    assert calls == ["render"]
    assert cache.size <= 6
    # A large tile is served without evicting the entire useful cache.
    size = cache.size
    assert cache.get_or_create("large", lambda: b"x" * 7) == b"x" * 7
    assert cache.size == size


def test_concurrent_duplicate_reads_share_one_render():
    cache = TileCache()
    entered, release = Event(), Event()
    calls = []

    def render():
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return b"pixels"

    with ThreadPoolExecutor(max_workers=3) as workers:
        first = workers.submit(cache.get_or_create, "same", render)
        try:
            assert entered.wait(5)
            second = workers.submit(cache.get_or_create, "same", render)
            # An unrelated tile can finish while the first one is blocked.
            other = workers.submit(cache.get_or_create, "other", lambda: b"other")
            assert other.result(timeout=5) == b"other"
        finally:
            release.set()
        assert first.result(timeout=5) == second.result(timeout=5) == b"pixels"
    assert calls == [1]


def test_failed_render_can_be_retried():
    cache = TileCache()
    with pytest.raises(OSError, match="Disconnected"):
        cache.get_or_create("tile", lambda: (_ for _ in ()).throw(OSError("Disconnected")))
    assert cache.get_or_create("tile", lambda: b"reconnected") == b"reconnected"


def test_clear_does_not_repopulate_cache_with_in_flight_old_data():
    cache = TileCache()
    entered, release = Event(), Event()

    def old_render():
        entered.set()
        assert release.wait(5)
        return b"old"

    with ThreadPoolExecutor(max_workers=1) as workers:
        result = workers.submit(cache.get_or_create, "tile", old_render)
        try:
            assert entered.wait(5)
            cache.clear()
            assert cache.get_or_create("tile", lambda: b"new") == b"new"
        finally:
            release.set()
        assert result.result(timeout=5) == b"old"
    assert cache.size == 3
    assert cache.get_or_create("tile", lambda: pytest.fail("Cache miss")) == b"new"
