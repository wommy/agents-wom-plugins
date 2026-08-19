"""Contract for the hooks: what gets injected, what gets blocked, what never does.

Loads the plugin as a package and drives the real hook functions, with the rail
subprocess stubbed. Every case fabricates its verdict -- none read the live tree,
which is the trap that once made two of these pass for the wrong reason when the
repo happened to be clean.
"""
import importlib.util
import os
import sys
import unittest

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAIL = {"command": "bun womr.ts kanban list"}
REPAIR = {"command": "pnpm install"}

ZERO = {"selfCount": 0, "foreignCount": 0, "danglingCount": 0,
        "unauthorizedCount": 0, "pnpmStoreCount": 0}
CLEAN = dict(kind="womr.rail.lanes-doctor", ok=True, findings=[], **ZERO)
BREACHED = dict(CLEAN, ok=False, unauthorizedCount=1,
                findings=[{"path": "/repo/node_modules/@womr/rail",
                           "kind": "unauthorized"}])
BLIND = None


def load(payload=BREACHED):
    """Load the plugin with the rail stubbed to return ``receipt``."""
    sys.modules.pop("wra", None)
    spec = importlib.util.spec_from_file_location(
        "wra", os.path.join(PKG, "__init__.py"), submodule_search_locations=[PKG]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["wra"] = mod
    spec.loader.exec_module(mod)
    mod._run_doctor = lambda repo: mod.doctor.verdict(payload)
    mod._cache["verdict"] = None
    mod.DEFAULT_REPO = PKG  # an existing dir, so the isdir guard passes
    return mod


class GateBase(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in
                       ("WOMR_RAIL_ANCHOR_ENFORCE", "WOMR_RAIL_ANCHOR_DISABLE", "WOMR_ROOT")}
        for k in self._saved:
            os.environ.pop(k, None)
        os.environ["WOMR_ROOT"] = PKG

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class TestWarning(GateBase):
    def test_silent_on_a_clean_rail(self):
        self.assertIsNone(load(CLEAN).pre_llm_call(session_id="s"))

    def test_reports_a_breach(self):
        r = load().pre_llm_call(session_id="s")
        self.assertIn("RAIL ANCHOR BREACH", (r or {}).get("context", ""))

    def test_warns_when_blind(self):
        # An unreadable instrument must surface, not pass silently.
        r = load(BLIND).pre_llm_call(session_id="s")
        self.assertIn("UNVERIFIED", (r or {}).get("context", ""))

    def test_kill_switch_silences_the_warning(self):
        os.environ["WOMR_RAIL_ANCHOR_DISABLE"] = "1"
        self.assertIsNone(load().pre_llm_call(session_id="s"))


class TestGate(GateBase):
    def test_default_is_warn_only(self):
        self.assertIsNone(load().pre_tool_call("terminal", RAIL))

    def test_enforced_blocks_the_rail(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        r = load().pre_tool_call("terminal", RAIL)
        self.assertEqual((r or {}).get("action"), "block")

    def test_enforced_never_gates_the_repair(self):
        # Blocking `pnpm install` would make the breach unfixable from inside.
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(load().pre_tool_call("terminal", REPAIR))

    def test_blind_never_blocks(self):
        # Warn on an unreadable instrument; do not wedge the operator's shell.
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(load(BLIND).pre_tool_call("terminal", RAIL))

    def test_clean_rail_never_blocks(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(load(CLEAN).pre_tool_call("terminal", RAIL))

    def test_only_the_terminal_tool_is_gated(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(load().pre_tool_call("read_file", RAIL))

    def test_unrelated_command_untouched(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(load().pre_tool_call("terminal", {"command": "ls -la"}))

    def test_missing_args_does_not_raise(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(load().pre_tool_call("terminal", None))

    def test_kill_switch_beats_enforcement(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        os.environ["WOMR_RAIL_ANCHOR_DISABLE"] = "1"
        self.assertIsNone(load().pre_tool_call("terminal", RAIL))


class TestCache(GateBase):
    def test_rail_is_invoked_once_within_the_interval(self):
        m = load()
        calls = []
        m._run_doctor = lambda repo: (calls.append(1), m.doctor.verdict(BREACHED))[1]
        m._cache["verdict"] = None
        m.pre_llm_call(session_id="s")
        m.pre_llm_call(session_id="s")
        self.assertEqual(len(calls), 1)


class TestBinaryResolution(GateBase):
    """The gateway PATH has neither bun nor toon; resolution must not rely on it."""

    def test_resolves_bun_to_an_executable_absolute_path(self):
        m = load()
        resolved = m._resolve(m.BUN_BIN_ENV, m._BUN_FALLBACKS)
        self.assertTrue(os.path.isabs(resolved), resolved)
        self.assertTrue(os.access(resolved, os.X_OK), resolved)

    def test_resolves_toon_to_an_executable_absolute_path(self):
        m = load()
        resolved = m._resolve(m.TOON_BIN_ENV, m._TOON_FALLBACKS)
        self.assertTrue(os.path.isabs(resolved), resolved)
        self.assertTrue(os.access(resolved, os.X_OK), resolved)

    def test_env_override_wins(self):
        m = load()
        os.environ["WOMR_TOON_BIN"] = "/custom/toon"
        try:
            self.assertEqual(m._resolve(m.TOON_BIN_ENV, m._TOON_FALLBACKS), "/custom/toon")
        finally:
            os.environ.pop("WOMR_TOON_BIN", None)


class TestBlindIsNotRepeated(GateBase):
    """Blind is a background condition; a confirmed breach is not."""

    def test_blind_warns_once_then_goes_quiet(self):
        m = load(BLIND)
        self.assertIsNotNone(m.pre_llm_call(session_id="s"))   # fresh
        self.assertIsNone(m.pre_llm_call(session_id="s"))      # cached -> quiet

    def test_confirmed_breach_keeps_warning_every_turn(self):
        m = load(BREACHED)
        self.assertIsNotNone(m.pre_llm_call(session_id="s"))
        self.assertIsNotNone(m.pre_llm_call(session_id="s"))


if __name__ == "__main__":
    unittest.main(verbosity=0)
