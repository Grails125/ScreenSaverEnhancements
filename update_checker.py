import json
import os
import re
import ssl
import urllib.request


GITHUB_RELEASE_API = "https://api.github.com/repos/Grails125/ScreenSaverEnhancements/releases/latest"
SYSTEM_CA_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ssl/certs/ca-bundle.crt",
)
UPDATE_CHECK_HEADERS = {
    "User-Agent": "ScreenSaverEnhancements-UpdateCheck",
    "Accept": "application/vnd.github+json",
}
MAX_RELEASE_RESPONSE_BYTES = 256 * 1024
MAX_RELEASE_NOTES_LENGTH = 8_000
VERSION_PATTERN = re.compile(r"^[vV]?(\d+)\.(\d+)\.(\d+)$")


def normalize_version(value):
    match = VERSION_PATTERN.fullmatch(value.strip() if isinstance(value, str) else "")
    if match is None:
        raise ValueError("invalid semantic version")
    return ".".join(str(int(part)) for part in match.groups())


def is_newer_version(latest, current):
    latest_parts = tuple(int(part) for part in normalize_version(latest).split("."))
    current_parts = tuple(int(part) for part in normalize_version(current).split("."))
    return latest_parts > current_parts


def parse_release_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("invalid release response")
    version = normalize_version(payload.get("tag_name"))
    notes = payload.get("body")
    if not isinstance(notes, str):
        notes = ""
    return {
        "version": version,
        "notes": notes.strip()[:MAX_RELEASE_NOTES_LENGTH],
    }


def _ssl_context():
    ca_bundle = next((path for path in SYSTEM_CA_BUNDLES if os.path.isfile(path)), None)
    return ssl.create_default_context(cafile=ca_bundle)


def fetch_latest_release():
    request = urllib.request.Request(GITHUB_RELEASE_API, headers=UPDATE_CHECK_HEADERS)
    with urllib.request.urlopen(request, context=_ssl_context(), timeout=8) as response:
        raw_payload = response.read(MAX_RELEASE_RESPONSE_BYTES + 1)
    if len(raw_payload) > MAX_RELEASE_RESPONSE_BYTES:
        raise ValueError("release response is too large")
    return parse_release_payload(json.loads(raw_payload.decode("utf-8")))
