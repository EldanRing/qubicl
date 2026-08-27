import hmac
import os
import re
import stat

from websockify.auth_plugins import AuthenticationError


KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")


class HeaderKeyAuth:
    """Authenticate a gateway-injected header against a protected key file."""

    def __init__(self, src=None):
        self.source = src

    def authenticate(self, headers, target_host, target_port):
        del target_host, target_port
        expected = self._read_key()
        received = headers.get("X-Qubicl-Viewer-Key")
        if (
            not isinstance(received, str)
            or not KEY_PATTERN.fullmatch(received)
            or not hmac.compare_digest(received, expected)
        ):
            raise AuthenticationError(
                response_code=403,
                response_msg="Forbidden",
                log_msg="viewer authentication failed",
            )

    def _read_key(self):
        if not self.source:
            self._unavailable()
        flags = os.O_RDONLY | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(self.source, flags)
            try:
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 128:
                    self._unavailable()
                with os.fdopen(descriptor, "r", encoding="ascii") as handle:
                    descriptor = -1
                    value = handle.read().removesuffix("\n")
            finally:
                if descriptor >= 0:
                    os.close(descriptor)
        except (OSError, TypeError, UnicodeError):
            self._unavailable()
        if not KEY_PATTERN.fullmatch(value):
            self._unavailable()
        return value

    @staticmethod
    def _unavailable():
        raise AuthenticationError(
            response_code=503,
            response_msg="Viewer unavailable",
            log_msg="viewer authentication key unavailable",
        )
