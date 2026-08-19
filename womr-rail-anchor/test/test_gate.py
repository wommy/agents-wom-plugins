"""Contract for the opt-in pre_tool_call gate.

Loads the plugin as a package (it uses a relative import) and drives the real
hook function, so these exercise the same code the runtime calls.
"""
import importlib.util
import os
import sys
import unittest

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAIL = {"command": "bun womr.ts kanban list"}
REPAIR = {"command": "pnpm install"}


def load():
    sys.modules.pop("wra", None)
    spec = importlib.util.spec_from_file_location(
        "wra", os.path.join(PKG, "__init__.py"), submodule_search_locations=[PKG]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["wra"] = mod
    spec.loader.exec_module(mod)
    return mod


class GateBase(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in
                       ("WOMR_RAIL_ANCHOR_ENFORCE", "WOMR_RAIL_ANCHOR_DISABLE")}
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def breached():
    """Load the plugin with a fabricated breach, so gate tests exercise the gate
    rather than passing trivially because the live rail happens to be clean."""
    m = load()
    m.audit = lambda *a, **k: [("@womr/rail", m.anchor.WORKSPACE)]
    m._cache["rows"] = None
    return m


class TestGate(GateBase):
    def test_default_is_warn_only(self):
        self.assertIsNone(load().pre_tool_call("terminal", RAIL))

    def test_enforced_blocks_the_rail(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        r = breached().pre_tool_call("terminal", RAIL)
        self.assertEqual((r or {}).get("action"), "block")
        self.assertTrue((r or {}).get("message"))

    def test_enforced_never_gates_the_repair(self):
        # Blocking `pnpm install` would make the breach unfixable from inside.
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(breached().pre_tool_call("terminal", REPAIR))

    def test_only_the_terminal_tool_is_gated(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(breached().pre_tool_call("read_file", RAIL))

    def test_kill_switch_beats_enforcement(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        os.environ["WOMR_RAIL_ANCHOR_DISABLE"] = "1"
        self.assertIsNone(breached().pre_tool_call("terminal", RAIL))

    def test_unrelated_command_untouched(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(breached().pre_tool_call("terminal", {"command": "ls -la"}))

    def test_missing_args_does_not_raise(self):
        os.environ["WOMR_RAIL_ANCHOR_ENFORCE"] = "1"
        self.assertIsNone(breached().pre_tool_call("terminal", None))

    def test_warning_hook_is_silent_on_a_clean_rail(self):
        m = load()
        m.audit = lambda *a, **k: [("@womr/rail", m.anchor.OK)]
        m._cache["rows"] = None
        self.assertIsNone(m.pre_llm_call(session_id="s", user_message="m"))

    def test_warning_hook_reports_a_breach(self):
        # Hermetic: fabricate the breach rather than reading the live repo, which
        # is now clean and previously made this test pass for the wrong reason.
        m = load()
        m.audit = lambda *a, **k: [("@womr/rail", m.anchor.WORKSPACE)]
        m._cache["rows"] = None
        r = m.pre_llm_call(session_id="s", user_message="m")
        self.assertIn("context", r or {})
        self.assertIn("RAIL ANCHOR BREACH", r["context"])


if __name__ == "__main__":
    unittest.main(verbosity=0)
