import unittest

from taskbook.models import Task, TaskError, normalise_tags, parse_iso


class TestTaskValidation(unittest.TestCase):
    def test_rejects_empty_title(self):
        with self.assertRaises(TaskError):
            Task(id=1, title="   ")

    def test_rejects_unknown_state(self):
        with self.assertRaises(TaskError) as ctx:
            Task(id=1, title="x", state="paused")
        self.assertIn("paused", str(ctx.exception))

    def test_rejects_unknown_priority(self):
        with self.assertRaises(TaskError):
            Task(id=1, title="x", priority="urgent")

    def test_created_defaults_to_today(self):
        task = Task(id=1, title="x")
        self.assertTrue(task.created)


class TestTaskRoundTrip(unittest.TestCase):
    def test_dict_round_trip(self):
        task = Task(id=7, title="write docs", tags=["docs"], priority="high")
        clone = Task.from_dict(task.to_dict())
        self.assertEqual(task, clone)

    def test_from_dict_ignores_unknown_keys(self):
        task = Task.from_dict({"id": 2, "title": "x", "colour": "blue"})
        self.assertEqual(task.id, 2)


class TestSortAndMatch(unittest.TestCase):
    def test_open_work_sorts_before_done(self):
        todo = Task(id=2, title="a")
        done = Task(id=1, title="b", state="done")
        self.assertLess(todo.sort_key(), done.sort_key())

    def test_high_priority_sorts_first(self):
        high = Task(id=2, title="a", priority="high")
        low = Task(id=1, title="b", priority="low")
        self.assertLess(high.sort_key(), low.sort_key())

    def test_matches_title_case_insensitively(self):
        self.assertTrue(Task(id=1, title="Write Docs").matches("docs"))

    def test_matches_tags(self):
        self.assertTrue(Task(id=1, title="x", tags=["urgent"]).matches("URG"))

    def test_no_false_match(self):
        self.assertFalse(Task(id=1, title="x", tags=["a"]).matches("zzz"))


class TestHelpers(unittest.TestCase):
    def test_normalise_tags_dedupes_and_lowercases(self):
        self.assertEqual(normalise_tags("Work, work ,HOME"), ["work", "home"])

    def test_normalise_tags_handles_empty(self):
        self.assertEqual(normalise_tags(None), [])
        self.assertEqual(normalise_tags("  "), [])

    def test_parse_iso_accepts_valid_date(self):
        self.assertEqual(parse_iso("2026-09-08").year, 2026)

    def test_parse_iso_rejects_garbage(self):
        with self.assertRaises(TaskError):
            parse_iso("not-a-date")


if __name__ == "__main__":
    unittest.main()
