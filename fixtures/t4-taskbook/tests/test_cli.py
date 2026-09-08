import io
import tempfile
import unittest
from pathlib import Path

from taskbook.cli import main
from taskbook.render import EMPTY_MESSAGE


class CliTestCase(unittest.TestCase):
    """Drives the CLI end to end against a throwaway store file."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "store.json"

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self, *argv):
        """Run one command, returning (exit_code, stdout, stderr)."""
        out, err = io.StringIO(), io.StringIO()
        code = main(["--file", str(self.path), *argv], out=out, err=err)
        return code, out.getvalue(), err.getvalue()


class TestAddAndList(CliTestCase):
    def test_add_then_list(self):
        self.assertEqual(self.run_cli("add", "write tests")[0], 0)
        code, out, _ = self.run_cli("list")
        self.assertEqual(code, 0)
        self.assertIn("write tests", out)

    def test_empty_list_shows_hint(self):
        _, out, _ = self.run_cli("list")
        self.assertIn(EMPTY_MESSAGE, out)

    def test_add_with_tags_and_priority(self):
        self.run_cli("add", "ship it", "--priority", "high", "--tags", "Work,work")
        _, out, _ = self.run_cli("list")
        self.assertIn("(work)", out)
        self.assertIn("!", out)

    def test_add_rejects_empty_title(self):
        code, _, err = self.run_cli("add", "   ")
        self.assertEqual(code, 1)
        self.assertIn("title", err)

    def test_list_filters_by_state(self):
        self.run_cli("add", "alpha")
        self.run_cli("add", "beta")
        self.run_cli("done", "1")
        _, out, _ = self.run_cli("list", "--state", "done")
        self.assertIn("alpha", out)
        self.assertNotIn("beta", out)

    def test_list_filters_by_tag(self):
        self.run_cli("add", "tagged", "--tags", "home")
        self.run_cli("add", "untagged")
        _, out, _ = self.run_cli("list", "--tag", "home")
        self.assertIn("tagged", out)
        self.assertNotIn("untagged", out)


class TestLifecycle(CliTestCase):
    def test_start_then_done(self):
        self.run_cli("add", "a task")
        self.assertEqual(self.run_cli("start", "1")[0], 0)
        _, out, _ = self.run_cli("list")
        self.assertIn("[~]", out)
        self.assertEqual(self.run_cli("done", "1")[0], 0)
        _, out, _ = self.run_cli("list")
        self.assertIn("[x]", out)

    def test_done_twice_fails(self):
        self.run_cli("add", "a task")
        self.run_cli("done", "1")
        code, _, err = self.run_cli("done", "1")
        self.assertEqual(code, 1)
        self.assertIn("already done", err)

    def test_start_a_done_task_fails(self):
        self.run_cli("add", "a task")
        self.run_cli("done", "1")
        code, _, err = self.run_cli("start", "1")
        self.assertEqual(code, 1)
        self.assertIn("reopen", err)

    def test_reopen_clears_completion_date(self):
        self.run_cli("add", "a task")
        self.run_cli("done", "1")
        self.assertEqual(self.run_cli("reopen", "1")[0], 0)
        _, out, _ = self.run_cli("list")
        self.assertIn("[ ]", out)

    def test_reopen_an_open_task_fails(self):
        self.run_cli("add", "a task")
        code, _, err = self.run_cli("reopen", "1")
        self.assertEqual(code, 1)
        self.assertIn("not done", err)

    def test_remove(self):
        self.run_cli("add", "a task")
        self.assertEqual(self.run_cli("remove", "1")[0], 0)
        _, out, _ = self.run_cli("list")
        self.assertIn(EMPTY_MESSAGE, out)

    def test_unknown_id_reports_cleanly(self):
        code, _, err = self.run_cli("done", "42")
        self.assertEqual(code, 1)
        self.assertIn("42", err)


class TestFindAndSummary(CliTestCase):
    def test_find_matches_title(self):
        self.run_cli("add", "buy milk")
        code, out, _ = self.run_cli("find", "MILK")
        self.assertEqual(code, 0)
        self.assertIn("buy milk", out)

    def test_find_no_match_exits_one(self):
        self.run_cli("add", "buy milk")
        code, out, _ = self.run_cli("find", "bread")
        self.assertEqual(code, 1)
        self.assertIn("nothing matches", out)

    def test_summary_counts_states(self):
        self.run_cli("add", "a")
        self.run_cli("add", "b")
        self.run_cli("done", "1")
        _, out, _ = self.run_cli("summary")
        self.assertIn("1 todo", out)
        self.assertIn("1 done", out)


class TestParserSurface(CliTestCase):
    def test_no_command_prints_help(self):
        code, out, _ = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("COMMAND", out)

    def test_help_lists_every_command(self):
        _, out, _ = self.run_cli()
        for name in ("add", "list", "find", "start", "done", "reopen", "remove", "summary"):
            self.assertIn(name, out)


if __name__ == "__main__":
    unittest.main()
