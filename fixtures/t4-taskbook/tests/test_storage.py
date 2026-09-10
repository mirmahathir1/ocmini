import json
import tempfile
import unittest
from pathlib import Path

from taskbook.models import Task, TaskError
from taskbook.storage import SCHEMA_VERSION, Store


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "store.json"

    def tearDown(self):
        self._tmp.cleanup()


class TestLoadSave(StoreTestCase):
    def test_missing_file_loads_empty(self):
        store = Store.load(self.path)
        self.assertEqual(store.tasks, [])
        self.assertEqual(store.next_id, 1)

    def test_save_then_load_round_trips(self):
        store = Store.load(self.path)
        store.add(Task(id=0, title="first"))
        store.add(Task(id=0, title="second", priority="high"))
        store.save()

        reloaded = Store.load(self.path)
        self.assertEqual([t.title for t in reloaded.tasks], ["first", "second"])
        self.assertEqual(reloaded.next_id, 3)

    def test_saved_file_declares_schema_version(self):
        store = Store.load(self.path)
        store.add(Task(id=0, title="x"))
        store.save()
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(raw["version"], SCHEMA_VERSION)

    def test_corrupt_json_raises(self):
        self.path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(TaskError):
            Store.load(self.path)

    def test_non_object_store_raises(self):
        self.path.write_text("[1, 2, 3]", encoding="utf-8")
        with self.assertRaises(TaskError):
            Store.load(self.path)

    def test_newer_schema_refuses_to_load(self):
        self.path.write_text(
            json.dumps({"version": SCHEMA_VERSION + 1, "tasks": []}), encoding="utf-8"
        )
        with self.assertRaises(TaskError) as ctx:
            Store.load(self.path)
        self.assertIn("newer", str(ctx.exception))

    def test_next_id_recovered_when_absent(self):
        self.path.write_text(
            json.dumps({"tasks": [{"id": 5, "title": "x"}]}), encoding="utf-8"
        )
        self.assertEqual(Store.load(self.path).next_id, 6)

    def test_save_leaves_no_temp_files(self):
        store = Store.load(self.path)
        store.add(Task(id=0, title="x"))
        store.save()
        leftovers = list(self.path.parent.glob("*.tmp"))
        self.assertEqual(leftovers, [])


class TestMutation(StoreTestCase):
    def test_add_assigns_sequential_ids(self):
        store = Store.load(self.path)
        first = store.add(Task(id=0, title="a"))
        second = store.add(Task(id=0, title="b"))
        self.assertEqual((first.id, second.id), (1, 2))

    def test_get_unknown_id_raises(self):
        with self.assertRaises(TaskError):
            Store.load(self.path).get(99)

    def test_remove_returns_and_drops(self):
        store = Store.load(self.path)
        store.add(Task(id=0, title="a"))
        removed = store.remove(1)
        self.assertEqual(removed.title, "a")
        self.assertEqual(store.tasks, [])

    def test_sorted_tasks_orders_by_key(self):
        store = Store.load(self.path)
        store.add(Task(id=0, title="done one", state="done"))
        store.add(Task(id=0, title="low", priority="low"))
        store.add(Task(id=0, title="high", priority="high"))
        titles = [t.title for t in store.sorted_tasks()]
        self.assertEqual(titles, ["high", "low", "done one"])


if __name__ == "__main__":
    unittest.main()
