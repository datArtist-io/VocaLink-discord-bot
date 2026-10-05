"""Circuit breaker per provider: closed -> open (after N failures) -> half-open."""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class CircuitBreaker:
    name: str
    failures_to_open: int = 3
    cooldown_s: float = 30.0
    max_cooldown_s: float = 600.0
    clock: callable = field(default=time.monotonic, repr=False)

    state: str = "closed"
    failures: int = 0
    opened_at: float = 0.0
    current_cooldown: float = 0.0
    last_error: str = ""
    total_failures: int = 0
    total_calls: int = 0

    def allow(self) -> bool:
        if self.state == "closed":
            return True
        if self.state == "open" and self.clock() - self.opened_at >= self.current_cooldown:
            self.state = "half_open"
            return True
        return self.state == "half_open"

    def success(self) -> None:
        self.total_calls += 1
        self.failures = 0
        self.state = "closed"
        self.current_cooldown = 0.0

    def failure(self, err: BaseException | str) -> None:
        self.total_calls += 1
        self.total_failures += 1
        self.last_error = str(err)[:300]
        self.failures += 1
        if self.state == "half_open" or self.failures >= self.failures_to_open:
            self.current_cooldown = (min(self.max_cooldown_s, self.current_cooldown * 2)
                                     if self.current_cooldown else self.cooldown_s)
            self.state = "open"
            self.opened_at = self.clock()

    def snapshot(self) -> dict:
        return {"state": self.state, "failures": self.failures, "total_failures": self.total_failures,
                "total_calls": self.total_calls, "last_error": self.last_error,
                "cooldown_s": self.current_cooldown}
