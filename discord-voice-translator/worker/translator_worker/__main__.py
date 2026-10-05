"""python -m translator_worker [--config config.yaml] [--plan] [--languages] [--gen-voice-key]"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys

from . import config as C
from . import hardware as H


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="translator_worker")
    ap.add_argument("--config", help="path to config.yaml (or WORKER_CONFIG env)")
    ap.add_argument("--plan", action="store_true", help="print hardware tier + model plan and exit")
    ap.add_argument("--languages", action="store_true", help="load providers, print the language tier table, exit")
    ap.add_argument("--gen-voice-key", action="store_true", help="print a new VOICE_PROFILE_KEY and exit")
    args = ap.parse_args(argv)

    if args.gen_voice_key:
        from .voices import generate_key
        print(generate_key())
        return 0

    cfg = C.load(args.config)
    logging.basicConfig(level=getattr(logging, cfg.log_level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.plan:
        hw = H.probe(cfg.hardware.tier, cfg.hardware.device)
        print(json.dumps(H.describe(hw, H.plan(hw, cfg)), indent=2))
        return 0

    from .app import WorkerApp

    app = WorkerApp(cfg)
    if args.languages:
        from . import registry as R
        rows = sorted(app.caps.values(), key=lambda c: (-c.tier, c.code))
        print(f"{'code':6} {'language':22} {'tier':16} {'stt':5} {'auto':5} reasons")
        for c in rows:
            print(f"{c.code:6} {c.name[:22]:22} {c.tier} {c.tier_label:14} {c.stt_grade:5} {str(c.auto_detect):5} "
                  f"{'; '.join(c.reasons)}")
        print(json.dumps(R.summary(app.caps)["counts"]))
        return 0

    async def run():
        await app.start()
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:  # pragma: no cover (Windows)
                pass
        await stop.wait()
        await app.stop()

    asyncio.run(run())
    return 0


if __name__ == "__main__":
    sys.exit(main())
