import json
import os
import re
import ssl
import urllib.request
from urllib.parse import urlparse


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
SHA256_DIGEST_PATTERN = re.compile(r"^sha256:([0-9a-fA-F]{64})$")
RELEASE_ASSET_NAME = "ScreenSaverEnhancements.zip"
RELEASE_DOWNLOAD_HOST = "github.com"
RELEASE_DOWNLOAD_PATH_PREFIX = "/Grails125/ScreenSaverEnhancements/releases/download/"


def normalize_version(value):
    match = VERSION_PATTERN.fullmatch(value.strip() if isinstance(value, str) else "")
    if match is None:
        raise ValueError("invalid semantic version")
    return ".".join(str(int(part)) for part in match.groups())


def read_package_version(package_path):
    with open(package_path, "r", encoding="utf-8") as package_file:
        package = json.load(package_file)
    if not isinstance(package, dict):
        raise ValueError("invalid package metadata")
    return normalize_version(package.get("version"))


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
    assets = payload.get("assets")
    if not isinstance(assets, list):
        raise ValueError("release assets are missing")
    asset = next((item for item in assets if isinstance(item, dict) and item.get("name") == RELEASE_ASSET_NAME), None)
    if asset is None:
        return {
            "version": version,
            "notes": notes.strip()[:MAX_RELEASE_NOTES_LENGTH],
            "download_url": "",
            "sha256": "",
        }
    download_url = asset.get("browser_download_url")
    parsed_url = urlparse(download_url if isinstance(download_url, str) else "")
    if (
        parsed_url.scheme != "https"
        or parsed_url.hostname != RELEASE_DOWNLOAD_HOST
        or not parsed_url.path.startswith(RELEASE_DOWNLOAD_PATH_PREFIX)
        or not parsed_url.path.endswith("/" + RELEASE_ASSET_NAME)
        or parsed_url.query
        or parsed_url.fragment
    ):
        raise ValueError("invalid release package URL")
    digest_match = SHA256_DIGEST_PATTERN.fullmatch(asset.get("digest") or "")
    if digest_match is None:
        raise ValueError("release package digest is missing")
    return {
        "version": version,
        "notes": notes.strip()[:MAX_RELEASE_NOTES_LENGTH],
        "download_url": download_url,
        "sha256": digest_match.group(1).lower(),
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
