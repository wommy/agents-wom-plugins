"""RED-first contract for skill-route reachability classification.

Pure-python. The classifier takes an ALREADY-BUILT index of discovered skill
directories, so every verdict is provable with plain dicts and lists -- no
filesystem, no hermes runtime, no network.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import reachability  # noqa: E402

AGENTS = "/home/wom/.agents/skills"
WOM = "/home/wom/.config/agents-wom/skills"


def entry(path, depth, target=None):
    """One discovered <dir>/SKILL.md. depth is measured FROM ITS ROOT."""
    return {"path": path, "depth": depth, "target": target or path}


class TestClassify(unittest.TestCase):
    def test_depth_one_entry_is_reachable(self):
        self.assertEqual(
            reachability.classify("penultimate", [entry(AGENTS + "/penultimate", 1)]),
            reachability.REACHABLE,
        )

    def test_nested_only_entry_is_dark(self):
        # Real, readable by absolute path, and un-invocable by bare name.
        self.assertEqual(
            reachability.classify(
                "systematic-debugging",
                [entry(AGENTS + "/superpowers/skills/systematic-debugging", 3)],
            ),
            reachability.DARK,
        )

    def test_no_entry_anywhere_is_not_a_skill(self):
        # The script's core insight: a bare word in prose is not a defect.
        # A naive nesting audit reports 1331/1535 dark and is useless.
        self.assertEqual(
            reachability.classify("penultimate", []), reachability.NOT_A_SKILL
        )

    def test_depth_one_wins_even_when_a_nested_copy_exists(self):
        # The CURE is a depth-1 symlink alongside the categorized path, so the
        # cured state has BOTH. It must read as reachable, not duplicate.
        rows = [
            entry(AGENTS + "/systematic-debugging", 1, target="/src/systematic-debugging"),
            entry(AGENTS + "/superpowers/skills/systematic-debugging", 3,
                  target="/src/systematic-debugging"),
        ]
        self.assertEqual(
            reachability.classify("systematic-debugging", rows), reachability.REACHABLE
        )

    def test_same_target_in_several_roots_is_reachable_not_duplicate(self):
        # The documented cure symlinks the SAME source into two roots. That is
        # the healthy state and must never be reported as an ambiguity.
        rows = [
            entry(AGENTS + "/hermes-local-durability", 1, target="/src/hld"),
            entry(WOM + "/hermes-local-durability", 1, target="/src/hld"),
        ]
        self.assertEqual(
            reachability.classify("hermes-local-durability", rows),
            reachability.REACHABLE,
        )

    def test_two_distinct_depth_one_targets_is_duplicate(self):
        # Which one the harness loads is scan-order dependent: the route is
        # loadable but not deterministic.
        rows = [
            entry(AGENTS + "/cvmn", 1, target="/src/a/cvmn"),
            entry(WOM + "/cvmn", 1, target="/src/b/cvmn"),
        ]
        self.assertEqual(reachability.classify("cvmn", rows), reachability.DUPLICATE)

    def test_deep_duplicates_do_not_make_a_dark_route_duplicate(self):
        rows = [
            entry(AGENTS + "/a/b/cvmn", 3, target="/src/a/cvmn"),
            entry(WOM + "/x/y/cvmn", 3, target="/src/b/cvmn"),
        ]
        self.assertEqual(reachability.classify("cvmn", rows), reachability.DARK)


class TestExtractRoutes(unittest.TestCase):
    def test_slash_route_is_extracted(self):
        self.assertIn("penultimate", reachability.extract_routes("apply /penultimate now"))

    def test_backtick_route_is_extracted(self):
        self.assertIn(
            "hermes-local-durability",
            reachability.extract_routes("load `hermes-local-durability` FIRST"),
        )

    def test_absolute_path_does_not_become_a_route(self):
        # `/home/wom/inbox` must not be mined as a route named "home".
        routes = reachability.extract_routes("see /home/wom/inbox/AGENTS.md")
        self.assertNotIn("wom", routes)
        self.assertNotIn("inbox", routes)

    def test_short_tokens_are_ignored(self):
        self.assertEqual(reachability.extract_routes("use /ab and `abc`"), [])

    def test_routes_are_unique_and_sorted(self):
        self.assertEqual(
            reachability.extract_routes("/zebra /alpha /zebra"), ["alpha", "zebra"]
        )


class TestAudit(unittest.TestCase):
    def test_dark_route_is_reported_with_its_source(self):
        index = {
            "systematic-debugging": [
                entry(AGENTS + "/superpowers/skills/systematic-debugging", 3)
            ],
            "penultimate": [entry(AGENTS + "/penultimate", 1)],
        }
        report = reachability.audit(["systematic-debugging", "penultimate"], index)
        self.assertEqual(
            [name for name, _src in report["dark"]], ["systematic-debugging"]
        )
        self.assertEqual(
            report["dark"][0][1], AGENTS + "/superpowers/skills/systematic-debugging"
        )

    def test_prose_words_are_silent(self):
        index = {"penultimate": [entry(AGENTS + "/penultimate", 1)]}
        report = reachability.audit(["penultimate", "hunger", "suspenders"], index)
        self.assertEqual(report["dark"], [])
        self.assertEqual(report["not_a_skill"], 2)
        self.assertFalse(report["blind"])

    def test_duplicate_is_reported_separately_from_dark(self):
        index = {
            "cvmn": [
                entry(AGENTS + "/cvmn", 1, target="/src/a"),
                entry(WOM + "/cvmn", 1, target="/src/b"),
            ],
            "dark-one": [entry(AGENTS + "/n/dark-one", 2)],
        }
        report = reachability.audit(["cvmn", "dark-one"], index)
        self.assertEqual([n for n, _t in report["duplicate"]], ["cvmn"])
        self.assertEqual([n for n, _s in report["dark"]], ["dark-one"])

    def test_report_is_deterministic(self):
        index = {n: [entry(AGENTS + "/n/" + n, 2)] for n in ("zeta", "alpha", "mid")}
        report = reachability.audit(["zeta", "alpha", "mid"], index)
        self.assertEqual([n for n, _s in report["dark"]], ["alpha", "mid", "zeta"])


class TestFailureToLook(unittest.TestCase):
    """An empty scan is a failure to look, NOT a clean pass.

    A detector that reports OK when it could not see is worse than no detector:
    it launders a broken scan into a green light. Both inputs can fail this way
    -- an unreadable skills root, and an unreadable/empty route source.
    """

    def test_empty_index_is_blind_not_clean(self):
        report = reachability.audit(["penultimate"], {})
        self.assertTrue(report["blind"])
        self.assertTrue(reachability.is_actionable(report))
        self.assertTrue(report["blind_reason"])

    def test_empty_routes_is_blind_not_clean(self):
        report = reachability.audit([], {"penultimate": [entry(AGENTS + "/p", 1)]})
        self.assertTrue(report["blind"])
        self.assertTrue(reachability.is_actionable(report))

    def test_a_genuinely_clean_audit_is_not_actionable(self):
        index = {"penultimate": [entry(AGENTS + "/penultimate", 1)]}
        report = reachability.audit(["penultimate"], index)
        self.assertFalse(report["blind"])
        self.assertFalse(reachability.is_actionable(report))

    def test_dark_route_is_actionable(self):
        index = {"x-ray-skill": [entry(AGENTS + "/n/x-ray-skill", 2)]}
        self.assertTrue(
            reachability.is_actionable(reachability.audit(["x-ray-skill"], index))
        )

    def test_duplicate_alone_is_actionable(self):
        index = {
            "cvmn": [
                entry(AGENTS + "/cvmn", 1, target="/a"),
                entry(WOM + "/cvmn", 1, target="/b"),
            ]
        }
        self.assertTrue(reachability.is_actionable(reachability.audit(["cvmn"], index)))


class TestCure(unittest.TestCase):
    def test_cure_names_a_depth_one_symlink_from_the_real_source(self):
        cure = reachability.cure_command(
            "systematic-debugging",
            AGENTS + "/superpowers/skills/systematic-debugging",
            [AGENTS, WOM],
        )
        self.assertIn("ln -sfn", cure)
        self.assertIn(AGENTS + "/superpowers/skills/systematic-debugging", cure)
        self.assertIn(AGENTS, cure)
        self.assertIn(WOM, cure)


if __name__ == "__main__":
    unittest.main(verbosity=0)
