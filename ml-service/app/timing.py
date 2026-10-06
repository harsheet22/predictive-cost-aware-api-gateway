"""Prediction timings use durations, never clocks shared between processes."""
from time import perf_counter


class PredictionTimingMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") != "/predict":
            return await self.app(scope, receive, send)
        started = perf_counter()

        async def timed_send(message):
            if message["type"] == "http.response.start":
                timing = scope.get("state", {}).get("prediction_timing", {})
                processing_ms = (perf_counter() - started) * 1000
                headers = list(message.get("headers", []))
                headers.append((b"server-timing", (
                    f"fastapi;dur={processing_ms:.6f}, "
                    f"rf;dur={timing.get('inferenceMs', 0):.6f}, "
                    f"worker_queue;dur={timing.get('workerQueueMs', 0):.6f}"
                ).encode("ascii")))
                if timing.get("fallback"):
                    headers.append((b"x-prediction-fallback", timing["fallback"].encode("ascii")))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, timed_send)
