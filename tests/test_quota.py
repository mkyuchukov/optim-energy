"""Focused tests for shared-service quotas."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "optim_energy_quota",
    ROOT / "custom_components" / "optim_energy" / "quota.py",
)
assert spec and spec.loader
quota_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quota_module)
BillReadLimitExceeded = quota_module.BillReadLimitExceeded
BillReadQuota = quota_module.BillReadQuota


class QuotaTests(unittest.TestCase):
    def test_user_limit_resets_after_the_window(self) -> None:
        now = 100.0
        quota = BillReadQuota(
            user_limit=2,
            client_limit=10,
            window_seconds=60,
            clock=lambda: now,
        )
        quota.consume(user_id="u1", client_id="c1")
        quota.consume(user_id="u1", client_id="c1")
        with self.assertRaises(BillReadLimitExceeded) as caught:
            quota.consume(user_id="u1", client_id="c1")
        self.assertEqual(caught.exception.retry_after, 60)
        now = 161.0
        quota.consume(user_id="u1", client_id="c1")

    def test_client_limit_spans_users(self) -> None:
        now = 0.0
        quota = BillReadQuota(
            user_limit=5,
            client_limit=2,
            window_seconds=60,
            clock=lambda: now,
        )
        quota.consume(user_id="u1", client_id="c1")
        quota.consume(user_id="u2", client_id="c1")
        with self.assertRaises(BillReadLimitExceeded):
            quota.consume(user_id="u3", client_id="c1")
        quota.consume(user_id="u1", client_id="c2")


if __name__ == "__main__":
    unittest.main()
