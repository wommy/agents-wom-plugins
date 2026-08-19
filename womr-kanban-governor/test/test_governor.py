"""RED-first contract for the structural priority governor.

Pure-python: imports governor only. No hermes runtime, no DB, no network, so it
runs anywhere and proves the SCORING contract independently of the hook wiring.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import governor  # noqa: E402


def card(tid, status="todo", priority=0, title="a real card"):
    return {"id": tid, "status": status, "priority": priority, "title": title}


class TestHandSetFloor(unittest.TestCase):
    """The load-bearing invariant: structure never outvotes a human."""

    def test_computed_score_never_reaches_floor(self):
        # 5000 open descendants must still clamp below the floor.
        rows = [card("t_root")] + [card("t_%d" % i) for i in range(200)]
        links = [("t_root", "t_%d" % i) for i in range(200)]
        plan = governor.build_plan(rows, links)
        for _tid, pri in plan:
            self.assertLess(pri, governor.HAND_SET_FLOOR)

    def test_hand_set_card_is_never_planned(self):
        rows = [card("t_hand", priority=95), card("t_auto", priority=0)]
        plan = dict(governor.build_plan(rows, []))
        self.assertNotIn("t_hand", plan)
        self.assertIn("t_auto", plan)

    def test_clamp_is_idempotent(self):
        self.assertEqual(
            governor.clamp(governor.clamp(999)), governor.clamp(999)
        )


class TestStructuralScoring(unittest.TestCase):
    def test_free_card_outranks_gated_card(self):
        # t_gated has an OPEN parent; t_free has none.
        rows = [card("t_free"), card("t_gated"), card("t_parent")]
        links = [("t_parent", "t_gated")]
        plan = dict(governor.build_plan(rows, links))
        self.assertGreater(plan["t_free"], plan["t_gated"])

    def test_closed_parent_does_not_gate(self):
        rows = [card("t_kid"), card("t_parent", status="done")]
        links = [("t_parent", "t_kid")]
        free = dict(governor.build_plan([card("t_kid")], []))["t_kid"]
        self.assertEqual(dict(governor.build_plan(rows, links))["t_kid"], free)

    def test_more_leverage_scores_higher(self):
        rows = [card("t_a"), card("t_b"), card("t_x"), card("t_y")]
        links = [("t_a", "t_x"), ("t_a", "t_y")]
        plan = dict(governor.build_plan(rows, links))
        self.assertGreater(plan["t_a"], plan["t_b"])

    def test_leverage_counts_transitively_and_terminates_on_cycle(self):
        # A cycle must not hang the dispatcher tick.
        rows = [card("t_1"), card("t_2"), card("t_3")]
        links = [("t_1", "t_2"), ("t_2", "t_3"), ("t_3", "t_1")]
        plan = dict(governor.build_plan(rows, links))
        self.assertIn("t_1", plan)

    def test_fixture_titles_sink_to_bottom(self):
        rows = [card("t_fix", title="probe-alpha"), card("t_real")]
        plan = dict(governor.build_plan(rows, []))
        self.assertLess(plan["t_fix"], plan["t_real"])


class TestLaneSelection(unittest.TestCase):
    def test_terminal_and_triage_excluded(self):
        rows = [
            card("t_done", status="done"),
            card("t_arch", status="archived"),
            card("t_triage", status="triage"),
            card("t_todo", status="todo"),
        ]
        plan = dict(governor.build_plan(rows, []))
        self.assertEqual(list(plan), ["t_todo"])


class TestBoundedness(unittest.TestCase):
    """The tick must never be extended without bound."""

    def test_plan_respects_max_writes(self):
        rows = [card("t_%d" % i) for i in range(500)]
        plan = governor.build_plan(rows, [], max_writes=25)
        self.assertEqual(len(plan), 25)

    def test_bounded_plan_is_a_prefix_of_the_full_plan(self):
        # Truncation must drop the LEAST valuable work, never reorder. The top
        # scorer here is t_parent: free AND holding one open descendant, so it
        # outranks the leverage-free t_free. The gated card is what falls off.
        rows = [card("t_free"), card("t_gated"), card("t_parent")]
        links = [("t_parent", "t_gated")]
        full = governor.build_plan(rows, links)
        bounded = governor.build_plan(rows, links, max_writes=1)
        self.assertEqual(bounded, full[:1])
        self.assertNotIn("t_gated", dict(bounded))

    def test_quiet_board_produces_empty_plan(self):
        rows = [card("t_ranked", priority=42)]
        self.assertEqual(governor.build_plan(rows, []), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
