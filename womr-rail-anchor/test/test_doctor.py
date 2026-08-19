"""Contract for the verdict rule over a decoded lanes-doctor receipt.

PURE: every case feeds a dict. No rail, no subprocess, no toon, no filesystem --
the decision rule is provable without a working womr checkout.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import doctor  # noqa: E402

ZERO = {f: 0 for f in doctor.COUNT_FIELDS}


def receipt(**over):
    r = {"kind": doctor.RECEIPT_KIND, "ok": True, "findings": []}
    r.update(ZERO)
    r.update(over)
    return r


BREACH_ROW = {
    "path": "/repo/node_modules/@womr/rail",
    "kind": "unauthorized",
    "actualRoot": "/tmp/elsewhere",
    "reason": "outside",
}


class TestVerdict(unittest.TestCase):
    def test_clean_receipt_is_not_a_breach(self):
        v = doctor.verdict(receipt())
        self.assertFalse(v.breach)
        self.assertFalse(v.blind)

    def test_unauthorized_count_breaches(self):
        v = doctor.verdict(receipt(ok=False, unauthorizedCount=1, findings=[BREACH_ROW]))
        self.assertTrue(v.breach)
        self.assertEqual(v.counts["unauthorizedCount"], 1)

    def test_foreign_count_breaches(self):
        self.assertTrue(doctor.verdict(receipt(ok=False, foreignCount=2)).breach)

    def test_nonzero_count_breaches_even_when_ok_is_true(self):
        # ok and the counts must agree; if they disagree, do not report clean.
        self.assertTrue(doctor.verdict(receipt(ok=True, danglingCount=1)).breach)

    def test_findings_rows_are_extracted(self):
        v = doctor.verdict(receipt(ok=False, unauthorizedCount=1, findings=[BREACH_ROW]))
        self.assertEqual(v.findings, [("/repo/node_modules/@womr/rail", "unauthorized")])


class TestBlind(unittest.TestCase):
    """An unreadable instrument must never read as clean."""

    def test_none_is_blind(self):
        self.assertTrue(doctor.verdict(None).blind)

    def test_non_dict_is_blind(self):
        self.assertTrue(doctor.verdict([1, 2]).blind)

    def test_wrong_kind_is_blind(self):
        self.assertTrue(doctor.verdict(receipt(kind="something.else")).blind)

    def test_missing_ok_field_is_blind(self):
        r = receipt()
        del r["ok"]
        self.assertTrue(doctor.verdict(r).blind)

    def test_non_integer_count_is_blind(self):
        self.assertTrue(doctor.verdict(receipt(foreignCount="lots")).blind)

    def test_boolean_count_is_blind_not_coerced(self):
        # bool is an int subclass in python; True must not read as count 1.
        self.assertTrue(doctor.verdict(receipt(foreignCount=True)).blind)

    def test_blind_is_always_also_a_breach(self):
        self.assertTrue(doctor.verdict(None).breach)


class TestMessage(unittest.TestCase):
    def test_message_names_the_rail_as_authority(self):
        self.assertIn("lanes doctor", doctor.message(doctor.verdict(receipt(ok=False))))

    def test_message_lists_offending_paths(self):
        m = doctor.message(doctor.verdict(receipt(ok=False, unauthorizedCount=1, findings=[BREACH_ROW])))
        self.assertIn("@womr/rail", m)

    def test_blind_message_says_it_could_not_look(self):
        self.assertIn("could not", doctor.message(doctor.verdict(None)).lower())


if __name__ == "__main__":
    unittest.main(verbosity=0)
