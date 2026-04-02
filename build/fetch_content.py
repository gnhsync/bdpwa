#!/usr/bin/env python3
"""
fetch_content.py — Check for new Bugs & Drugs content and download if needed.

Mimics the Android app's update flow:
  1. Hit the startup endpoint to get the current version and zip filename
  2. Compare against the local content zip's export_version.json
  3. Download the new zip if versions differ (or if --force)
  4. Verify the zip's export_version.json matches the startup response

Uses a per-installation UUID for requests, generated on first run and
stored in data/.device_uuid.

Usage:
    python3 build/fetch_content.py [--force]

Exit codes:
    0  — content is up to date (or was updated successfully)
    1  — error (network, verification, etc.)
    2  — new content downloaded (signals that a rebuild is needed)
"""

import argparse
import json
import sys
import urllib.request
import uuid
import zipfile
from pathlib import Path

BASE_URL = "https://bdpublic.bugsanddrugs.org"
DATA_DIR = Path(__file__).parent.parent / "data"
ZIP_PATH = DATA_DIR / "content.zip"
UUID_PATH = DATA_DIR / ".device_uuid"


def get_device_uuid() -> str:
    if UUID_PATH.exists():
        return UUID_PATH.read_text().strip()
    device_id = uuid.uuid4().hex[:16]
    UUID_PATH.write_text(device_id)
    return device_id


def get_local_version() -> dict | None:
    if not ZIP_PATH.exists():
        return None
    try:
        with zipfile.ZipFile(ZIP_PATH) as zf:
            return json.loads(zf.read("export_version.json"))
    except (KeyError, json.JSONDecodeError, zipfile.BadZipFile):
        return None


def fetch_startup(device_uuid: str) -> dict:
    url = f"{BASE_URL}/current?uuid={device_uuid}&status=startup"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def download_zip(zip_filename: str, device_uuid: str) -> None:
    url = f"{BASE_URL}/api/v1/release/{zip_filename}?uuid={device_uuid}"
    req = urllib.request.Request(url)
    print(f"  Downloading {zip_filename} …")
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    ZIP_PATH.write_bytes(data)
    print(f"  Saved {ZIP_PATH} ({len(data) / 1e6:.1f} MB)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true",
                        help="Download even if versions match")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    device_uuid = get_device_uuid()

    print(f"Device UUID: {device_uuid}")

    print("Checking upstream version …")
    try:
        startup = fetch_startup(device_uuid)
    except Exception as e:
        print(f"  Failed to reach startup endpoint: {e}", file=sys.stderr)
        sys.exit(1)

    remote = startup.get("current", {})
    zip_filename = startup.get("zip")
    remote_version = remote.get("version")
    remote_date = remote.get("date")

    print(f"  Remote: v{remote_version} ({remote_date})")

    if not zip_filename:
        print("  No zip filename in startup response", file=sys.stderr)
        sys.exit(1)

    local = get_local_version()
    if local:
        print(f"  Local:  v{local.get('version')} ({local.get('date')})")
    else:
        print("  Local:  (none)")

    if not args.force and local and local.get("version") == remote_version:
        print("Content is up to date.")
        sys.exit(0)

    if args.force:
        print("  --force: downloading regardless")

    try:
        download_zip(zip_filename, device_uuid)
    except Exception as e:
        print(f"  Download failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Verify the downloaded zip matches what the startup endpoint reported
    downloaded = get_local_version()
    if not downloaded:
        print("  ERROR: downloaded zip has no export_version.json", file=sys.stderr)
        sys.exit(1)

    if downloaded.get("version") != remote_version:
        print(f"  ERROR: version mismatch — expected {remote_version}, "
              f"got {downloaded.get('version')}", file=sys.stderr)
        sys.exit(1)

    print(f"Verified: v{downloaded['version']} ({downloaded.get('date')})")
    sys.exit(2)


if __name__ == "__main__":
    main()
