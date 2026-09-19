"""Best-effort terminal presentation of a hosted Harmony handoff."""

from __future__ import annotations

import base64
import os
import sys
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, TextIO, Tuple
from urllib.parse import quote, unquote

from .spotify_api import canonical_album_url, parse_album_reference

HARMONY_RELEASE_URL = "https://harmony.pulsewidth.org.uk/release"


def canonical_harmony_url(spotify_url: str) -> str:
    """Create the sole V1 URL from a supported Spotify *album* reference."""
    decoded_reference = unquote(spotify_url)
    canonical = canonical_album_url(parse_album_reference(decoded_reference))
    return "{0}?url={1}&region=US".format(HARMONY_RELEASE_URL, quote(canonical, safe=""))


def osc52_copy(text: str) -> bytes:
    return b"\x1b]52;c;" + base64.b64encode(text.encode("utf-8")) + b"\x07"


@dataclass(frozen=True)
class HandoffResult:
    url: str
    osc52_emitted: bool
    qr_rendered: bool
    warnings: Tuple[str, ...]


class TerminalHandoff:
    """Writes a URL first; optional terminal conveniences can never block import."""

    def __init__(
        self,
        output: Optional[TextIO] = None,
        *,
        byte_output: Optional[Any] = None,
        environ: Optional[Mapping[str, str]] = None,
        is_tty: Optional[Callable[[], bool]] = None,
        warning: Optional[Callable[[str], None]] = None,
        segno_module: Optional[Any] = None,
    ) -> None:
        self._output = output if output is not None else sys.stdout
        self._byte_output = byte_output
        self._environ = environ if environ is not None else os.environ
        self._is_tty = is_tty or (lambda: bool(getattr(self._output, "isatty", lambda: False)()))
        self._warning = warning or (lambda _message: None)
        self._segno = segno_module

    def present(self, spotify_url: str, *, osc52: bool = True, qr: bool = True) -> HandoffResult:
        url = canonical_harmony_url(spotify_url)
        warnings = []
        self._write_text(url + "\n")
        if not self._terminal_usable():
            return HandoffResult(url, False, False, ())
        emitted = False
        rendered = False
        if osc52:
            try:
                self._write_osc(osc52_copy(url))
                emitted = True
            except Exception as exc:
                warnings.append("OSC 52 clipboard copy unavailable: {0}".format(type(exc).__name__))
        if qr:
            try:
                segno = self._segno
                if segno is None:
                    import segno  # type: ignore[import-not-found]

                    segno = segno
                code = segno.make(url)
                code.terminal(out=self._output, compact=True)
                rendered = True
            except Exception as exc:
                warnings.append("terminal QR unavailable: {0}".format(type(exc).__name__))
        for message in warnings:
            self._warning(message)
        return HandoffResult(url, emitted, rendered, tuple(warnings))

    def _terminal_usable(self) -> bool:
        try:
            return self._is_tty() and self._environ.get("TERM", "") != "dumb"
        except Exception:
            return False

    def _write_text(self, value: str) -> None:
        self._output.write(value)
        flush = getattr(self._output, "flush", None)
        if callable(flush):
            flush()

    def _write_osc(self, payload: bytes) -> None:
        target = self._byte_output if self._byte_output is not None else getattr(self._output, "buffer", None)
        if target is not None:
            target.write(payload)
            flush = getattr(target, "flush", None)
            if callable(flush):
                flush()
            return
        self._write_text(payload.decode("ascii"))
