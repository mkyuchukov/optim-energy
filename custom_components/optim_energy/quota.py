"""Small in-memory quotas for shared external services."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
import time


class BillReadLimitExceeded(RuntimeError):
    """Raised when a bill-read request would exceed its quota."""

    def __init__(self, retry_after: int) -> None:
        super().__init__(f"Bill reader limit reached. Try again in {retry_after} seconds.")
        self.retry_after = retry_after


class BillReadQuota:
    """Limit bill-read calls per user and per client in a sliding window."""

    def __init__(
        self,
        *,
        user_limit: int = 5,
        client_limit: int = 30,
        window_seconds: int = 3600,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.user_limit = user_limit
        self.client_limit = client_limit
        self.window_seconds = window_seconds
        self.clock = clock
        self._users: dict[str, deque[float]] = {}
        self._clients: dict[str, deque[float]] = {}

    def consume(self, *, user_id: str, client_id: str) -> None:
        """Record one request or raise before the external service is called."""
        now = self.clock()
        cutoff = now - self.window_seconds
        user_calls = self._users.setdefault(user_id, deque())
        client_calls = self._clients.setdefault(client_id, deque())
        for calls in (user_calls, client_calls):
            while calls and calls[0] <= cutoff:
                calls.popleft()
        if len(user_calls) >= self.user_limit:
            raise BillReadLimitExceeded(
                max(1, int(self.window_seconds - (now - user_calls[0])))
            )
        if len(client_calls) >= self.client_limit:
            raise BillReadLimitExceeded(
                max(1, int(self.window_seconds - (now - client_calls[0])))
            )
        user_calls.append(now)
        client_calls.append(now)
