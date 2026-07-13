import asyncio


class ManagedTask:
    def __init__(self):
        self.task = None

    def schedule(self, coroutine_factory):
        if self.task is not None and not self.task.done():
            return False
        self.task = asyncio.create_task(coroutine_factory())
        return True

    async def cancel_and_wait(self):
        task = self.task
        self.task = None
        if task is None:
            return
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
