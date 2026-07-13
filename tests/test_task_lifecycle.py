import asyncio
import unittest

from task_lifecycle import ManagedTask


class ManagedTaskTests(unittest.TestCase):
    def test_cancellation_waits_for_the_pending_task_to_finish(self):
        async def scenario():
            task_slot = ManagedTask()
            started = asyncio.Event()
            finished = asyncio.Event()

            async def pending_work():
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    finished.set()

            self.assertTrue(task_slot.schedule(pending_work))
            self.assertFalse(task_slot.schedule(pending_work))
            await started.wait()
            await task_slot.cancel_and_wait()

            self.assertTrue(finished.is_set())
            self.assertIsNone(task_slot.task)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
