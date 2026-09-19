"""Small, non-fatal error vocabulary for Harmony service boundaries."""

from __future__ import annotations


class HarmonyError(Exception):
    """An expected Harmony failure; callers must return control to beets."""


class CredentialsUnavailable(HarmonyError):
    """Spotify client credentials have not been configured."""


class InvalidReference(HarmonyError):
    """An external-service identifier or URL is not an accepted exact reference."""


class ServiceUnavailable(HarmonyError):
    """A service request failed, timed out, or returned an HTTP failure."""


class RateLimitExceeded(ServiceUnavailable):
    """A service asked Harmony to wait longer than its configured budget."""


class DeadlineExceeded(ServiceUnavailable):
    """A bounded MusicBrainz lookup ran out of its absolute time budget."""


class MalformedResponse(HarmonyError):
    """A service response did not meet the narrow protocol contract."""


class LookupAmbiguous(HarmonyError):
    """More than one externally discovered release passed validation."""
