"""A byte-bounded cache of rendered tiles, shared across slide handles."""

from collections import OrderedDict
from concurrent.futures import Future
from threading import RLock


class TileCache:
    def __init__(self, max_bytes=64 * 1024 * 1024):
        self.max_bytes = max_bytes
        self.size = 0
        self._tiles = OrderedDict()
        self._pending = {}
        self._lock = RLock()
        self._generation = 0

    def get_or_create(self, key, render):
        with self._lock:
            if key in self._tiles:
                self._tiles.move_to_end(key)
                return self._tiles[key]
            # The viewer and navigator can request the same tile together.
            # Share that work without blocking reads of other tiles.
            pending_key = (self._generation, key)
            pending = self._pending.get(pending_key)
            owner = pending is None
            if owner:
                pending = self._pending[pending_key] = Future()
        if not owner:
            return pending.result()
        try:
            data = render()
            with self._lock:
                if pending_key[0] == self._generation and len(data) <= self.max_bytes:
                    self._tiles[key] = data
                    self.size += len(data)
                    while self.size > self.max_bytes:
                        _, evicted = self._tiles.popitem(last=False)
                        self.size -= len(evicted)
            pending.set_result(data)
            return data
        except BaseException as exc:
            pending.set_exception(exc)
            raise
        finally:
            with self._lock:
                self._pending.pop(pending_key, None)

    def clear(self):
        with self._lock:
            self._generation += 1
            self._tiles.clear()
            self.size = 0
