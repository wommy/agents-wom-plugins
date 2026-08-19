"""RED-first contract for rail-anchor classification.

Pure-python. The classifier takes already-resolved (name, target) pairs so the
decision logic is provable without a filesystem; only scan() does IO.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import anchor  # noqa: E402

REPO = "/home/wom/infra/womr"
WS = "/home/wom/.hermes/kanban/workspaces"


class TestClassify(unittest.TestCase):
    def test_in_repo_link_is_ok(self):
        self.assertEqual(
            anchor.classify("@womr/rail", REPO + "/packages/rail", REPO, WS),
            anchor.OK,
        )

    def test_workspace_link_is_breach(self):
        self.assertEqual(
            anchor.classify("@womr/rail", WS + "/t_68ee6f89/packages/rail", REPO, WS),
            anchor.WORKSPACE,
        )

    def test_classification_follows_target_not_name(self):
        # The name is irrelevant. A non-@womr scope pointing into a workspace is
        # exactly as breached -- v1 of the bash audit walked only @womr and
        # missed @effect, reporting 3 breaches where there were 8.
        self.assertEqual(
            anchor.classify("@effect/bun-test", WS + "/t_x/packages/bun-test", REPO, WS),
            anchor.WORKSPACE,
        )
        # ...and an @womr name resolving in-repo is fine.
        self.assertEqual(
            anchor.classify("@womr/toon", REPO + "/packages/toon", REPO, WS),
            anchor.OK,
        )

    def test_ignored_residue_still_classified_by_target(self):
        self.assertEqual(
            anchor.classify("@womr/.ignored_rail", WS + "/t_y/repo/packages/rail", REPO, WS),
            anchor.WORKSPACE,
        )

    def test_cache_tier_is_its_own_class(self):
        # /tmp is a reapable tmpfs tier: not a workspace, still not durable.
        self.assertEqual(
            anchor.classify("@womr/rail", "/tmp/wom-cache/cloned/x/packages/rail", REPO, WS),
            anchor.CACHE,
        )

    def test_unrelated_outside_path_is_outside(self):
        self.assertEqual(
            anchor.classify("@womr/rail", "/opt/somewhere/rail", REPO, WS),
            anchor.OUTSIDE,
        )

    def test_unresolvable_target_is_outside_not_ok(self):
        # A dangling link must never be reported clean.
        self.assertEqual(anchor.classify("@womr/rail", None, REPO, WS), anchor.OUTSIDE)

    def test_repo_prefix_match_is_path_boundary_aware(self):
        # /home/wom/infra/womr-other must NOT count as inside /home/wom/infra/womr.
        self.assertNotEqual(
            anchor.classify("@womr/rail", "/home/wom/infra/womr-other/pkg", REPO, WS),
            anchor.OK,
        )


class TestVerdict(unittest.TestCase):
    def test_breach_when_any_workspace_link(self):
        rows = [("@womr/rail", anchor.OK), ("@effect/bun-test", anchor.WORKSPACE)]
        self.assertTrue(anchor.is_breach(rows))

    def test_clean_when_all_ok(self):
        self.assertFalse(anchor.is_breach([("@womr/rail", anchor.OK)]))

    def test_empty_scan_is_not_clean(self):
        # Finding nothing means the scan could not see; it is not a pass.
        self.assertTrue(anchor.is_breach([]))

    def test_cache_counts_as_breach(self):
        self.assertTrue(anchor.is_breach([("@womr/rail", anchor.CACHE)]))



class TestPnpmStore(unittest.TestCase):
    """pnpm resolves deps outside the repo by design; that is not a breach."""

    STORE = "/home/wom/.wom-cache-tank/pnpm-store/v11/links/@/effect/4.0.0/ab/node_modules/effect"

    def test_pnpm_store_link_is_store_not_outside(self):
        self.assertEqual(anchor.classify("effect", self.STORE, REPO, WS), anchor.STORE)

    def test_store_is_not_a_breach(self):
        self.assertFalse(anchor.is_breach([("effect", anchor.STORE)]))

    def test_store_does_not_mask_a_real_breach(self):
        rows = [("effect", anchor.STORE), ("@womr/rail", anchor.WORKSPACE)]
        self.assertTrue(anchor.is_breach(rows))

    def test_xdg_pnpm_store_layout_also_recognised(self):
        self.assertEqual(
            anchor.classify("nx", "/home/wom/.local/share/pnpm/store/v11/links/x/nx", REPO, WS),
            anchor.STORE,
        )


if __name__ == "__main__":
    unittest.main(verbosity=0)
