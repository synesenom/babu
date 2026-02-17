"""
owlet.py
========
Unofficial Python client for the Owlet Smart Sock (v2/v3).

Public API
----------
    from owlet import Owlet

    owlet = Owlet("you@example.com", "password")
    owlet = Owlet("you@example.com", "password", region="europe")

    # Read once
    data = owlet.read()

    # Read continuously
    while True:
        data = owlet.read()
        print(data["heart_rate"], data["oxygen"])
        time.sleep(10)

Return value
------------
owlet.read() returns a dict with these keys:

    {
        "heart_rate":     int | None,   # BPM
        "oxygen":         int | None,   # %SpO2
        "battery":        int | None,   # %
        "movement":       str | None,   # "still" | "moving"
        "sock_off":       bool,
        "base_on":        bool,
        "charging":       bool,
        "sock_connected": bool,
        "dsn":            str,          # device serial number
        "timestamp":      str,          # "YYYY-MM-DD HH:MM:SS"
        "raw":            dict,         # full Ayla property dump
    }

Regions
-------
    "world"   – US and all other countries  (default)
    "europe"  – European accounts

Requirements
------------
    pip install requests

Technical notes
---------------
Auth flow reverse-engineered from the Owlet Android APK (credit: mbevand):
  1. Firebase identitytoolkit (with Android package/cert spoofing headers)
     → idToken (JWT)
  2. GET ayla-sso.owletdata.com/mini  → mini_token
  3. POST Ayla token_sign_in          → access_token  (+ expires_in)
  4. GET  Ayla /devices               → DSN list
  5. POST APP_ACTIVE = 1 on the device (triggers live-data broadcast)
  6. GET  Ayla /properties            → REAL_TIME_VITALS JSON blob
                                        (falls back to legacy individual props)
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Any

import requests

# ──────────────────────────────────────────────────────────────────────────────
# Internal constants  (all extracted from the Owlet Android APK)
# ──────────────────────────────────────────────────────────────────────────────

_REGIONS: dict[str, dict[str, str]] = {
    "world": {
        "firebase_api_key": "AIzaSyCsDZ8kWxQuLJAMVnmEhEkayH1TSxKXfGA",
        "url_mini":         "https://ayla-sso.owletdata.com/mini/",
        "url_signin":       "https://user-field-1a2039d9.aylanetworks.com/api/v1/token_sign_in",
        "url_base":         "https://ads-field-1a2039d9.aylanetworks.com/apiv1",
        "app_id":           "sso-prod-3g-id",
        "app_secret":       "sso-prod-UEjtnPCtFfjdwIwxqnC0OipxRFU",
    },
    "europe": {
        "firebase_api_key": "AIzaSyDm6EhV70wudwN3iOSq3vTjtsdGjdFLuuM",
        "url_mini":         "https://ayla-sso.eu.owletdata.com/mini/",
        "url_signin":       "https://user-field-eu-1a2039d9.aylanetworks.com/api/v1/token_sign_in",
        "url_base":         "https://ads-field-eu-1a2039d9.aylanetworks.com/apiv1",
        "app_id":           "OwletCare-Android-EU-fw-id",
        "app_secret":       "OwletCare-Android-EU-JKupMPBoj_Npce_9a95Pc8Qo0Mw",
    },
}

# The Firebase key is locked to the Owlet Android app; spoofing these headers
# is required or Google returns 400 "API key not valid".
_ANDROID_HEADERS: dict[str, str] = {
    "X-Android-Package": "com.owletcare.owletcare",
    "X-Android-Cert":    "2A3BC26DB0B8B0792DBE28E6FFDC2598F9B12B74",
}

# Newer firmware packs everything into one JSON-string property …
_PROP_RTV = "REAL_TIME_VITALS"
# … older firmware uses individual top-level properties (fallback).
_PROP_HR = "HEART_RATE"
_PROP_OX = "OXYGEN_LEVEL"
_PROP_BAT = "BATT_LEVEL"
_PROP_MV = "MOVEMENT"
_PROP_BASE = "BASE_STATION_ON"
_PROP_SOCK = "SOCK_OFF"
_PROP_CONN = "SOCK_CONNECTION"
_PROP_CHG = "CHARGE_STATUS"
_PROP_ACTIVE = "APP_ACTIVE"


# ──────────────────────────────────────────────────────────────────────────────
# Internal auth helpers
# ──────────────────────────────────────────────────────────────────────────────

def _firebase_sign_in(email: str, password: str, cfg: dict) -> str:
    """Step 1 – Firebase email/password → idToken (JWT)."""
    url = (
        "https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword"
        f"?key={cfg['firebase_api_key']}"
    )
    resp = requests.post(
        url,
        data=json.dumps({"email": email, "password": password, "returnSecureToken": True}),
        headers={**_ANDROID_HEADERS, "Content-Type": "application/json"},
        timeout=15,
    )
    if resp.status_code != 200:
        raise OwletError(f"Firebase sign-in failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    if "idToken" not in data:
        raise OwletError(f"Firebase sign-in: unexpected response: {data}")
    return data["idToken"]


def _get_mini_token(id_token: str, cfg: dict) -> str:
    """Step 2 – Firebase JWT → Owlet/Ayla mini_token."""
    resp = requests.get(cfg["url_mini"], headers={"Authorization": id_token}, timeout=15)
    if resp.status_code != 200:
        raise OwletError(f"SSO mini-token failed ({resp.status_code}): {resp.text}")
    mini = resp.json().get("mini_token")
    if not mini:
        raise OwletError(f"SSO mini-token: unexpected response: {resp.text}")
    return mini


def _ayla_sign_in(mini_token: str, cfg: dict) -> tuple[str, int]:
    """Step 3 – mini_token → (access_token, expires_in_seconds)."""
    resp = requests.post(
        cfg["url_signin"],
        json={
            "app_id":     cfg["app_id"],
            "app_secret": cfg["app_secret"],
            "provider":   "owl_id",
            "token":      mini_token,
        },
        timeout=15,
    )
    if resp.status_code not in (200, 201):
        raise OwletError(f"Ayla sign-in failed ({resp.status_code}): {resp.text}")
    data = resp.json()
    token = data.get("access_token")
    if not token:
        raise OwletError(f"Ayla sign-in: no access_token in response: {data}")
    return token, int(data.get("expires_in", 86400))


def _authenticate(email: str, password: str, cfg: dict) -> tuple[str, float]:
    """
    Full auth chain: Firebase → SSO → Ayla.

    Returns (access_token, expiry_timestamp).
    """
    id_token = _firebase_sign_in(email, password, cfg)
    mini_token = _get_mini_token(id_token, cfg)
    token, ttl = _ayla_sign_in(mini_token, cfg)
    expiry = time.monotonic() + ttl - 60   # re-auth 60 s before expiry
    return token, expiry


# ──────────────────────────────────────────────────────────────────────────────
# Internal device helpers
# ──────────────────────────────────────────────────────────────────────────────

def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"auth_token {token}"}


def _get_dsns(token: str, cfg: dict) -> list[str]:
    """Step 4 – return all device serial numbers on the account."""
    resp = requests.get(
        f"{cfg['url_base']}/devices.json",
        headers=_auth_header(token),
        timeout=15,
    )
    if resp.status_code != 200:
        raise OwletError(f"Device list failed ({resp.status_code}): {resp.text}")
    devices = resp.json()
    if not devices:
        raise OwletError("No Owlet devices found on this account.")
    return [d["device"]["dsn"] for d in devices]


def _activate(dsn: str, token: str, cfg: dict) -> None:
    """Step 5 – POST APP_ACTIVE=1 so the base station streams live data."""
    resp = requests.post(
        f"{cfg['url_base']}/dsns/{dsn}/properties/{_PROP_ACTIVE}/datapoints.json",
        json={"datapoint": {"metadata": {}, "value": 1}},
        headers=_auth_header(token),
        timeout=15,
    )
    if resp.status_code not in (200, 201):
        raise OwletError(f"APP_ACTIVE post failed ({resp.status_code}): {resp.text}")


def _get_props(dsn: str, token: str, cfg: dict) -> dict[str, Any]:
    """Step 6 – fetch all device properties as {name: value}."""
    resp = requests.get(
        f"{cfg['url_base']}/dsns/{dsn}/properties.json",
        headers=_auth_header(token),
        timeout=15,
    )
    if resp.status_code != 200:
        raise OwletError(f"Property fetch failed ({resp.status_code}): {resp.text}")
    return {p["property"]["name"]: p["property"]["value"] for p in resp.json()}


# ──────────────────────────────────────────────────────────────────────────────
# Internal reading parser
# ──────────────────────────────────────────────────────────────────────────────

def _parse(dsn: str, props: dict[str, Any]) -> dict[str, Any]:
    """
    Normalise raw Ayla properties into the public dict format.

    Tries REAL_TIME_VITALS (newer firmware) first, falls back to legacy
    individual properties.
    """
    rtv: dict | None = None
    raw_rtv = props.get(_PROP_RTV)
    if isinstance(raw_rtv, str) and raw_rtv.strip().startswith("{"):
        try:
            rtv = json.loads(raw_rtv)
        except json.JSONDecodeError:
            pass

    if rtv is not None:
        sock_connected = bool(rtv.get("sc"))
        return {
            "heart_rate":     rtv.get("hr"),
            "oxygen":         rtv.get("ox"),
            "battery":        rtv.get("bat"),
            "movement":       "moving" if rtv.get("mv") else "still",
            "sock_off": not sock_connected,
            "sock_connected": sock_connected,
            "base_on":        bool(rtv.get("bso")),
            "charging":       bool(rtv.get("chg")),
            "dsn":            dsn,
            "timestamp":      datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "raw":            props,
        }

    # Legacy firmware fallback
    mv = props.get(_PROP_MV)
    return {
        "heart_rate":     props.get(_PROP_HR),
        "oxygen":         props.get(_PROP_OX),
        "battery":        props.get(_PROP_BAT),
        "movement":       ("moving" if mv else "still") if isinstance(mv, int) else None,
        "sock_off":       bool(props.get(_PROP_SOCK)),
        "sock_connected": bool(props.get(_PROP_CONN)),
        "base_on":        bool(props.get(_PROP_BASE)),
        "charging":       bool(props.get(_PROP_CHG)),
        "dsn":            dsn,
        "timestamp":      datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "raw":            props,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Public exception
# ──────────────────────────────────────────────────────────────────────────────

class OwletError(Exception):
    """Raised for any Owlet API error (auth failures, network issues, etc.)."""


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────

class Owlet:
    """
    Owlet Smart Sock client.

    Authenticates once during initialization, then automatically re-authenticates
    when the session token expires.

    Example
    -------
        from owlet import Owlet

        owlet = Owlet("you@example.com", "password")
        data = owlet.read()
        print(data["heart_rate"], data["oxygen"])

        # Read in a loop
        while True:
            data = owlet.read()
            print(data["heart_rate"], data["oxygen"])
            time.sleep(10)
    """

    def __init__(
        self,
        email: str,
        password: str,
        region: str = "world",
        *,
        dsn: str | None = None,
    ):
        """
        Create an Owlet client and authenticate.

        Parameters
        ----------
        email    : Owlet account email address.
        password : Owlet account password.
        region   : "world" (default) or "europe".
        dsn      : Device serial number.  When omitted the first device on the
                   account is used.  Only needed if you have multiple socks.

        Raises
        ------
        OwletError  – on auth or API failure.
        ValueError  – if an unknown region is given.
        """
        if region not in _REGIONS:
            raise ValueError(f"region must be one of {list(_REGIONS)}")

        self._email = email
        self._password = password
        self._cfg = _REGIONS[region]

        # Authenticate immediately
        self._token, self._expiry = _authenticate(email, password, self._cfg)

        # Fetch DSN list and store the target
        dsns = _get_dsns(self._token, self._cfg)
        self._dsn = dsn or dsns[0]

    def read(self) -> dict[str, Any]:
        """
        Wake the device and return one reading.

        Returns
        -------
        dict with keys:
            heart_rate (int|None), oxygen (int|None), battery (int|None),
            movement (str|None), sock_off (bool), sock_connected (bool),
            base_on (bool), charging (bool), dsn (str), timestamp (str),
            raw (dict)

        Raises
        ------
        OwletError  – on any API failure.
        """
        # Re-authenticate proactively if token is about to expire
        if time.monotonic() >= self._expiry:
            self._token, self._expiry = _authenticate(
                self._email, self._password, self._cfg
            )

        _activate(self._dsn, self._token, self._cfg)
        time.sleep(2)  # give the base station a moment to push a fresh reading

        props = _get_props(self._dsn, self._token, self._cfg)
        return _parse(self._dsn, props)
