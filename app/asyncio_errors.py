"""Narrow workaround for noisy Windows Proactor socket teardown callbacks."""
from __future__ import annotations

import asyncio
import logging
import sys

logger = logging.getLogger(__name__)


def install_disconnect_handler(loop: asyncio.AbstractEventLoop):
    """Return the previous handler, preserving it for all unrelated exceptions.

    A remote TCP reset can raise again inside Proactor's connection-lost cleanup
    on Windows. This is log mitigation, not a fix for the network disconnect.
    """
    previous = loop.get_exception_handler()

    def handler(active_loop, context):
        error = context.get("exception")
        callback = getattr(context.get("handle"), "_callback", None)
        if (sys.platform == "win32"
                and isinstance(error, ConnectionResetError)
                and getattr(error, "winerror", None) == 10054
                and getattr(callback, "__module__", "") == "asyncio.proactor_events"
                and getattr(callback, "__qualname__", "") ==
                "_ProactorBasePipeTransport._call_connection_lost"):
            logger.debug("Remote peer reset a Windows socket during teardown: %s", error)
            return
        if previous is not None:
            previous(active_loop, context)
        else:
            active_loop.default_exception_handler(context)

    loop.set_exception_handler(handler)
    return previous
