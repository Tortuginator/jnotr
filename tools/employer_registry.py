#!/usr/bin/env python3
"""Build and maintain the Trondheim employer registry.

The registry is a CSV that ATS skills read: one row per employer, with the
employer's organisation number, name, local headcount, recruitment system and
everything that system needs to list its jobs. Six subcommands build it:

  fetch     page through the Brønnøysund register for local units in the
            commute municipalities and write a deterministic JSON snapshot.
  rollup    group those units under their top-level organisation (stopping
            below a ministry), sum local headcount and rank by it.
  merge     union a working registry with one or more curated seed files by
            organisation number, preserving manual base values.
  discover  read each employer's website, one career-page hop, a small number
            of job listings and their apply links, and detect the recruitment
            system from links, widgets, scripts and redirects. Third-party
            hosts loaded by those pages are recorded as a debug aid.
  probe     try vendors' public feeds by company-name slug and keep a hit only
            when the feed's company name matches the registry name.
  rebuild   run fetch, rollup, discover and probe in one command.

The CSV is user-owned data. `rollup --seed`, `merge` and every re-run of
`discover` or `probe` preserve the values a human already set: `aliases`,
`ats`, `ats_ref`, `enabled`, `website`, `career_url`, `confidence`, `status`,
`relevance`, `theme` and `set`. `third_party_hosts` is discovered debug data
and may be rewritten by `discover`.

Only the standard library is used. HTTP goes through `http_get`, a module-level
function that every command accepts as a `getter=` argument, so tests use
recorded fixtures and never touch the network.

Usage:
  python3 tools/employer_registry.py fetch
  python3 tools/employer_registry.py rollup --seed trondheim-patches/employers.seed.csv
  python3 tools/employer_registry.py merge --base job_scraper/employers.csv \\
      --seed trondheim-patches/employers.seed.set2.csv \\
      --out job_scraper/employers.csv --enable-relevance
  python3 tools/employer_registry.py discover
  python3 tools/employer_registry.py probe
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
import tempfile
import time
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from html import unescape
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_UNITS = ROOT / "job_scraper" / "brreg_units.json"
DEFAULT_CSV = ROOT / "job_scraper" / "employers.csv"
DEFAULT_SEED = ROOT / "trondheim-patches" / "employers.seed.csv"
DEFAULT_MUNICIPALITIES = "5001,5031,5028,5029,5035"

COLUMNS = [
    "orgnr",
    "name",
    "aliases",
    "trd_staff",
    "nace",
    "website",
    "career_url",
    "ats",
    "ats_ref",
    "confidence",
    "enabled",
    "status",
    "relevance",
    "theme",
    "set",
    "third_party_hosts",
]

USER_AGENT = "Mozilla/5.0 (compatible; employer-registry/1.0)"
AGENT_TOKEN = "employer-registry"
REGISTRY_BASE = "https://data.brreg.no/enhetsregisteret/api"
RETRY_STATUS = {429, 500, 502, 503, 504}
MAX_PARENT_DEPTH = 8


@dataclass
class Response:
    """What the transport returns. Tests build these directly."""

    url: str
    status: int
    text: str
    headers: dict


@dataclass(frozen=True)
class Detection:
    ats: str
    ref: str
    confidence: str
    evidence: str = ""


def http_get(url: str, timeout: float = 10.0) -> Response:
    """Fetch one URL. The only place this tool opens a socket."""
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read().decode(charset, errors="replace")
            headers = {key.lower(): value for key, value in response.headers.items()}
            return Response(response.geturl(), getattr(response, "status", 200), body, headers)
    except HTTPError as exc:
        charset = exc.headers.get_content_charset() if exc.headers else None
        try:
            body = exc.read().decode(charset or "utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - a failed error body is not fatal
            body = ""
        headers = {key.lower(): value for key, value in (exc.headers or {}).items()}
        return Response(exc.geturl() or url, exc.code, body, headers)
    except (URLError, OSError, ValueError):
        return Response(url, 0, "", {})


_BOT_STRONG = (
    "just a moment",
    "cf-challenge",
    "cf_chl_opt",
    "checking your browser",
    "verify you are human",
    "are you a robot",
    "incapsula incident",
    "request unsuccessful",
    "ddos protection by",
)
_BOT_MARKERS = _BOT_STRONG + ("captcha", "access denied")


def _looks_like_bot(text: str) -> bool:
    low = (text or "").lower()
    return any(marker in low for marker in _BOT_STRONG)


def get_with_backoff(
    url: str,
    *,
    getter=http_get,
    timeout: float = 10.0,
    retries: int = 3,
    sleep=time.sleep,
) -> Response:
    """GET with jittered backoff on 429/5xx and transport failures.

    A bot-verification body is never retried: the page has already answered,
    and repeating the request is exactly what the site asked us not to do.
    """
    response = Response(url, 0, "", {})
    for attempt in range(retries + 1):
        response = getter(url, timeout=timeout)
        if _is_bot_page(response):
            return response
        if response.status not in RETRY_STATUS and response.status != 0:
            return response
        if attempt < retries:
            delay = min(8.0, 0.5 * (2**attempt)) + random.uniform(0, 0.4)
            sleep(delay)
    return response


def _force_utf8_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8")


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _mkdir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def write_json_atomic(path: Path, data) -> None:
    path = Path(path)
    _mkdir(path)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_csv_atomic(path: Path, rows, *, lineterminator: str = "\n") -> None:
    """Write the registry in a stable column order, then rename into place."""
    path = Path(path)
    _mkdir(path)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=COLUMNS,
                lineterminator=lineterminator,
                extrasaction="ignore",
            )
            writer.writeheader()
            for row in rows:
                writer.writerow({column: row.get(column, "") or "" for column in COLUMNS})
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _detect_line_terminator(path: Path) -> str:
    """Return the newline style already used by a CSV file, defaulting to LF."""
    try:
        with open(path, "rb") as handle:
            sample = handle.read(65536)
    except OSError:
        return "\n"
    return "\r\n" if b"\r\n" in sample else "\n"


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return [{column: (row.get(column) or "") for column in COLUMNS} for row in reader]


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------


def _parse_municipalities(value) -> list[str]:
    if isinstance(value, (list, tuple)):
        items = value
    else:
        items = str(value).split(",")
    out = []
    for item in items:
        item = str(item).strip()
        if item and item not in out:
            out.append(item)
    return out


def _unit_record(unit: dict, municipality: str) -> dict:
    address = unit.get("beliggenhetsadresse") or {}
    parent = unit.get("overordnetEnhet")
    return {
        "orgnr": str(unit.get("organisasjonsnummer") or ""),
        "name": unit.get("navn") or "",
        "staff": int(unit.get("antallAnsatte") or 0),
        "nace": ((unit.get("naeringskode1") or {}).get("kode") or ""),
        "parent_orgnr": str(parent) if parent else "",
        "parent_name": "",
        "parents": [],
        "municipality": str(unit.get("kommunenummer") or address.get("kommunenummer") or municipality),
        "municipality_name": address.get("kommune") or "",
        "postnummer": address.get("postnummer") or "",
        "poststed": address.get("poststed") or "",
        "website": unit.get("hjemmeside") or "",
    }


def _fetch_entity(orgnr: str, *, getter, timeout: float, sleep) -> dict | None:
    response = get_with_backoff(
        f"{REGISTRY_BASE}/enheter/{orgnr}", getter=getter, timeout=timeout, sleep=sleep
    )
    if response.status != 200:
        return None
    try:
        data = json.loads(response.text)
    except (TypeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _resolve_parent_chains(units: list[dict], *, getter, timeout: float, sleep) -> None:
    """Attach each unit's parent chain, immediate parent first.

    Underenheter expose `overordnetEnhet` as a bare organisation number, so the
    names (and the ministry at the top) come from one entity lookup per parent.
    The cache makes shared parents cheap.
    """
    cache: dict[str, dict | None] = {}
    for unit in units:
        current = unit.get("parent_orgnr") or ""
        chain = []
        seen: set[str] = set()
        while current and current not in seen and len(chain) < MAX_PARENT_DEPTH:
            seen.add(current)
            if current in cache:
                entity = cache[current]
            else:
                entity = _fetch_entity(current, getter=getter, timeout=timeout, sleep=sleep)
                cache[current] = entity
            if not entity:
                break
            chain.append({"orgnr": current, "name": entity.get("navn") or ""})
            current = str(entity.get("overordnetEnhet") or "")
        unit["parents"] = chain
        if chain:
            unit["parent_orgnr"] = chain[0]["orgnr"]
            unit["parent_name"] = chain[0]["name"]


def fetch_units(
    *,
    municipalities=DEFAULT_MUNICIPALITIES,
    min_staff: int = 50,
    out=DEFAULT_UNITS,
    size: int = 100,
    max_pages: int | None = None,
    timeout: float = 15.0,
    getter=http_get,
    sleep=time.sleep,
) -> dict:
    """Page through the register and write a deterministic unit snapshot."""
    municipalities = _parse_municipalities(municipalities)
    units: dict[str, dict] = {}
    pages_fetched = 0
    by_municipality: dict[str, int] = {}

    for municipality in municipalities:
        by_municipality[municipality] = 0
        page = 0
        while True:
            if max_pages is not None and page >= max_pages:
                break
            query = urlencode(
                {
                    "kommunenummer": municipality,
                    "fraAntallAnsatte": min_staff,
                    "size": size,
                    "page": page,
                }
            )
            response = get_with_backoff(
                f"{REGISTRY_BASE}/underenheter?{query}",
                getter=getter,
                timeout=timeout,
                sleep=sleep,
            )
            if response.status == 404:
                break
            if response.status != 200:
                raise RuntimeError(
                    f"Brønnøysund returned HTTP {response.status} for municipality "
                    f"{municipality} page {page}"
                )
            try:
                payload = json.loads(response.text)
            except (TypeError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"Brønnøysund returned invalid JSON: {exc}") from exc
            embedded = payload.get("_embedded") or {}
            page_units = embedded.get("underenheter") or []
            pages_fetched += 1
            if not page_units:
                break
            for raw in page_units:
                if not isinstance(raw, dict):
                    continue
                record = _unit_record(raw, municipality)
                if not record["orgnr"]:
                    continue
                if record["orgnr"] in units:
                    continue
                units[record["orgnr"]] = record
                by_municipality[municipality] = by_municipality.get(municipality, 0) + 1
            page_meta = payload.get("page") or {}
            total_pages = page_meta.get("totalPages")
            number = page_meta.get("number", page)
            page += 1
            if isinstance(total_pages, int) and number + 1 >= total_pages:
                break

    ordered = sorted(units.values(), key=lambda unit: (unit["orgnr"], unit["name"]))
    _resolve_parent_chains(ordered, getter=getter, timeout=timeout, sleep=sleep)

    fetched_at = _utc_now()
    snapshot = {
        "fetched_at": fetched_at,
        "municipalities": municipalities,
        "min_staff": min_staff,
        "size": size,
        "units": ordered,
    }
    write_json_atomic(Path(out), snapshot)
    return {
        "out": str(out),
        "fetched_at": fetched_at,
        "municipalities": municipalities,
        "min_staff": min_staff,
        "units": len(ordered),
        "pages_fetched": pages_fetched,
        "by_municipality": by_municipality,
    }


# ---------------------------------------------------------------------------
# rollup
# ---------------------------------------------------------------------------

MINISTRY = re.compile(r"departement", re.IGNORECASE)


def _is_ministry(name: str) -> bool:
    return bool(MINISTRY.search(name or ""))


def _merge_aliases(*values) -> str:
    out: list[str] = []
    for value in values:
        for part in str(value or "").split("|"):
            part = part.strip()
            if part and part not in out:
                out.append(part)
    return "|".join(out)


def _group_for_unit(unit: dict) -> tuple[str, str, str]:
    """Return (orgnr, name, immediate_parent_name) for one local unit.

    The top-level organisation is the last ancestor in the chain. If that
    ancestor is a ministry or department, the immediate parent is kept instead,
    so an agency is not rolled up into the ministry that owns it.
    """
    chain = unit.get("parents") or []
    if not chain and unit.get("parent_orgnr"):
        chain = [
            {
                "orgnr": str(unit.get("parent_orgnr") or ""),
                "name": unit.get("parent_name") or "",
            }
        ]
    if not chain:
        return str(unit.get("orgnr") or ""), unit.get("name") or "", ""
    top = chain[-1]
    immediate = chain[0]
    if _is_ministry(top.get("name") or ""):
        return (
            str(immediate.get("orgnr") or ""),
            immediate.get("name") or "",
            immediate.get("name") or "",
        )
    return (
        str(top.get("orgnr") or ""),
        top.get("name") or "",
        immediate.get("name") or "",
    )


def rank_units(units: list[dict]) -> list[dict]:
    """Group local units and return rows ranked by summed local headcount."""
    groups: dict[str, dict] = {}
    for unit in sorted(units, key=lambda item: (str(item.get("orgnr") or ""), item.get("name") or "")):
        orgrn, name, parent_name = _group_for_unit(unit)
        if not orgrn:
            continue
        local_name = unit.get("name") or ""
        group = groups.setdefault(
            orgrn,
            {
                "orgnr": orgrn,
                "name": name or local_name,
                "aliases": [],
                "trd_staff": 0,
                "nace_counts": {},
            },
        )
        if not group["name"] and (name or local_name):
            group["name"] = name or local_name
        group["trd_staff"] += int(unit.get("staff") or 0)
        for alias in (local_name, parent_name):
            if alias and alias not in group["aliases"]:
                group["aliases"].append(alias)
        nace = unit.get("nace") or ""
        if nace:
            group["nace_counts"][nace] = group["nace_counts"].get(nace, 0) + 1

    rows = []
    for group in groups.values():
        counts = group.pop("nace_counts")
        nace = ""
        if counts:
            nace = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0][0]
        rows.append(
            {
                "orgnr": group["orgnr"],
                "name": group["name"],
                "aliases": "|".join(group["aliases"]),
                "trd_staff": group["trd_staff"],
                "nace": nace,
                "website": "",
                "career_url": "",
                "ats": "none",
                "ats_ref": "",
                "confidence": "",
                "enabled": "true",
                "status": "",
                "relevance": "",
                "theme": "",
                "set": "",
                "third_party_hosts": "",
            }
        )
    rows.sort(key=lambda row: (-int(row["trd_staff"]), row["orgnr"]))
    return rows


def _seed_row(row: dict) -> dict:
    out = {column: (row.get(column) or "") for column in COLUMNS}
    if not out["ats"]:
        out["ats"] = "none"
    if not out["enabled"]:
        out["enabled"] = "true"
    return out


def merge_seed(
    rows: list[dict], seed_rows: list[dict], top: int, *, preserve_seed: bool = False
) -> list[dict]:
    """Keep manual seed values, and use the seed to fill names and short lists.

    Every human-owned column survives a rebuild. The computed rank stays
    authoritative for ordering and headcount. With ``preserve_seed`` every seed
    row not already present is appended even beyond ``top``: a refresh must not
    silently drop a curated employer (and its ATS connector) because a newer
    unit snapshot ranked a different set of 150. Without it, a seed row is
    appended only when the computed ranking is shorter than ``top``.
    """
    seed_by_orgnr = {row["orgnr"]: row for row in seed_rows if row.get("orgnr")}
    merged: list[dict] = []
    used: set[str] = set()
    for row in rows[:top]:
        out = dict(row)
        seed = seed_by_orgnr.get(row["orgnr"])
        if seed:
            seed = _seed_row(seed)
            if seed["name"]:
                out["name"] = seed["name"]
            out["aliases"] = _merge_aliases(out.get("aliases"), seed.get("aliases"))
            for column in ("website", "career_url", "ats", "ats_ref", "confidence", "enabled", "status"):
                if seed.get(column):
                    out[column] = seed[column]
            for column in ("relevance", "theme", "set", "third_party_hosts"):
                if not out.get(column) and seed.get(column):
                    out[column] = seed[column]
        if not out.get("ats"):
            out["ats"] = "none"
        if not out.get("enabled"):
            out["enabled"] = "true"
        used.add(out["orgnr"])
        merged.append(out)

    if preserve_seed or len(merged) < top:
        for seed in seed_rows:
            if not preserve_seed and len(merged) >= top:
                break
            orgnr = seed.get("orgnr") or ""
            if not orgnr or orgnr in used:
                continue
            merged.append(_seed_row(seed))
            used.add(orgnr)
    return merged if preserve_seed else merged[:top]


def _normalise_row(row: dict) -> dict:
    return {column: (row.get(column) or "") for column in COLUMNS}


def _normalise_ats(value: str) -> str:
    return (value or "").strip().lower()


def _is_real_ats(value: str) -> bool:
    value = _normalise_ats(value)
    return bool(value and value != "none")


def _merge_registry_row(base: dict, seed: dict, conflicts: list[dict]) -> bool:
    """Merge one seed row into a base row, keeping non-empty human values.

    ``status`` is never copied into an existing base row: for curated rows it
    is a manual value, and a blank status is itself a deliberate choice.
    """
    before = dict(base)

    for column in (
        "name",
        "aliases",
        "enabled",
        "website",
        "career_url",
        "relevance",
        "theme",
        "set",
        "third_party_hosts",
    ):
        if not base.get(column) and seed.get(column):
            base[column] = seed[column]

    for column in ("trd_staff", "nace"):
        if not base.get(column) and seed.get(column):
            base[column] = seed[column]

    base_ats = _normalise_ats(base.get("ats"))
    seed_ats = _normalise_ats(seed.get("ats"))
    base_ref = (base.get("ats_ref") or "").strip()
    seed_ref = (seed.get("ats_ref") or "").strip()
    base_status = (base.get("status") or "").strip()
    locked_none = base_ats == "none" and bool(base_status)

    if locked_none:
        if _is_real_ats(seed_ats):
            conflicts.append(
                {
                    "orgnr": base.get("orgnr", ""),
                    "base_ats": base_ats,
                    "seed_ats": seed_ats,
                    "kept": base_ats,
                }
            )
    elif not _is_real_ats(base_ats):
        if _is_real_ats(seed_ats):
            base["ats"] = (seed.get("ats") or "").strip()
            base["ats_ref"] = seed_ref
            if seed.get("confidence"):
                base["confidence"] = seed["confidence"]
    elif _is_real_ats(seed_ats) and base_ats == seed_ats:
        if not base_ref:
            if seed_ref:
                base["ats_ref"] = seed_ref
            if seed.get("confidence"):
                base["confidence"] = seed["confidence"]
    elif _is_real_ats(seed_ats) and base_ats != seed_ats:
        conflicts.append(
            {
                "orgnr": base.get("orgnr", ""),
                "base_ats": base_ats,
                "seed_ats": seed_ats,
                "kept": base_ats,
            }
        )

    return base != before


def merge_rows(
    base_rows: list[dict], seed_rows: list[dict], *, enable_relevance: bool = False
) -> tuple[list[dict], dict]:
    """Union rows by organisation number, keeping the base order.

    Base rows keep every human value, including a deliberately blank ``status``;
    seed rows only fill gaps and add employers that are not in the base. New
    rows follow the order they appear across the seed files. With
    ``enable_relevance`` the ``enabled`` switch of newly appended rows is derived
    from ``relevance``; existing rows are never touched. A later seed row for an
    employer already appended in this run may fill its relevance/theme/set and
    ATS fields, then re-derives ``enabled`` when the flag is set.
    """
    rows = [_normalise_row(row) for row in base_rows]
    index = {row["orgnr"]: row for row in rows if row.get("orgnr")}
    base_orgnrs = set(index)
    appended: set[str] = set()
    added = 0
    updated = 0
    conflicts: list[dict] = []

    for raw in seed_rows:
        seed = _normalise_row(raw)
        orgnr = seed["orgnr"].strip()
        if not orgnr:
            continue
        seed["orgnr"] = orgnr
        base = index.get(orgnr)
        if base is None:
            if enable_relevance:
                seed["enabled"] = (
                    "true" if _normalise_ats(seed.get("relevance")) in ("high", "possible") else "false"
                )
            if not seed.get("ats"):
                seed["ats"] = "none"
            if not seed.get("enabled"):
                seed["enabled"] = "true"
            rows.append(seed)
            index[orgnr] = seed
            appended.add(orgnr)
            added += 1
            continue
        if orgnr in appended:
            _merge_registry_row(base, seed, conflicts)
            if enable_relevance:
                base["enabled"] = (
                    "true" if _normalise_ats(base.get("relevance")) in ("high", "possible") else "false"
                )
            continue
        if _merge_registry_row(base, seed, conflicts) and orgnr in base_orgnrs:
            updated += 1

    summary = {
        "base_rows": len(base_rows),
        "added": added,
        "updated": updated,
        "conflicts": conflicts,
        "total": len(rows),
    }
    return rows, summary


def rollup_units(
    *,
    units_path=DEFAULT_UNITS,
    out=DEFAULT_CSV,
    seed_path=None,
    top: int = 150,
    preserve_seed: bool = False,
) -> dict:
    try:
        data = json.loads(Path(units_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"cannot read units snapshot {units_path}: {exc}") from exc
    if isinstance(data, dict):
        units = data.get("units") or []
    else:
        units = data
    if not isinstance(units, list):
        raise RuntimeError("units snapshot must contain a list of units")
    rows = rank_units([unit for unit in units if isinstance(unit, dict)])
    if seed_path:
        seed_rows = read_csv(Path(seed_path))
        rows = merge_seed(rows, seed_rows, top, preserve_seed=preserve_seed)
    else:
        rows = rows[:top]
    write_csv_atomic(Path(out), rows)
    return {
        "out": str(out),
        "units": len(units),
        "employers": len(rows),
        "with_seed": bool(seed_path),
        "preserve_seed": bool(preserve_seed),
        "top": top,
    }


# ---------------------------------------------------------------------------
# detect / discover
# ---------------------------------------------------------------------------

TEAMTAILOR_RSS = re.compile(r"(https?://[^\s\"'<>]+?/jobs\.rss)", re.IGNORECASE)
TEAMTAILOR_HOST = re.compile(r"https?://([a-z0-9-]+)\.teamtailor\.com", re.IGNORECASE)
WEB_APPLOCK = re.compile(r"companylock=(\d+)", re.IGNORECASE)
WEB_HOST = re.compile(r"https?://([a-z0-9-]+)\.webcruiter\.com", re.IGNORECASE)
REACHMEE = re.compile(r"https?://[^\s\"'<>]*reachmee\.com[^\s\"'<>]*", re.IGNORECASE)
REACHMEE_APP = re.compile(
    r"rmpage=apply|reachmeeapplication|customerjs/I\d+-\d+-\d+\.js", re.IGNORECASE
)
SMART_API = re.compile(
    r"https?://api\.smartrecruiters\.com/v1/companies/([A-Za-z0-9._-]+)", re.IGNORECASE
)
SMART_ANY = re.compile(r"https?://[^\s\"'<>]*smartrecruiters\.com[^\s\"'<>]*", re.IGNORECASE)
HR_RSS = re.compile(
    r"https?://[^\s\"'<>]*PositionList/rss/([A-Za-z0-9._-]+)", re.IGNORECASE
)
HR_SVC = re.compile(
    r"JobPortal\.svc/([A-Za-z0-9._-]+)/PositionList/rss", re.IGNORECASE
)
HR_CUSTOMER = re.compile(r"[?&]customer=([^&#\"'\s<>]+)", re.IGNORECASE)
HR_CID = re.compile(r"[?&]cid=(\d+)", re.IGNORECASE)
JOBNORGE = re.compile(r"https?://[^\s\"'<>]*jobbnorge\.no[^\s\"'<>]*", re.IGNORECASE)

VISMA_CAREER = re.compile(
    r"https?://hire\.vismatalent\.com/[^\s\"'<>]*?/public/careers/[A-Za-z0-9-]+",
    re.IGNORECASE,
)
VISMA_SITEGUID = re.compile(
    r"GetJobList\?[^\s\"'<>]*?siteGuid=([^&\s\"'<>]+)", re.IGNORECASE
)
VISMA_HOST = re.compile(r"https?://hire\.vismatalent\.com[^\s\"'<>]*", re.IGNORECASE)

AVATURE_MARK = re.compile(r"avature\.net|avacdn\.net|avature\.portal", re.IGNORECASE)
AVATURE_URL = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)

DONEAI_URL = re.compile(
    r"https?://(?:[a-z0-9-]+\.)*done\.ai(?:[/?#][^\s\"'<>]*)?", re.IGNORECASE
)
CAREERHUB_URL = re.compile(
    r"https?://(?:[a-z0-9-]+\.)*careerhub\.se(?:[/?#][^\s\"'<>]*)?", re.IGNORECASE
)
HEARTPACE_URL = re.compile(
    r"https?://(?:[a-z0-9-]+\.)*heartpace\.com(?=[/?#\"'\s<>]|$)[^\s\"'<>]*",
    re.IGNORECASE,
)
JOBBSYS_URL = re.compile(
    r"https?://(?:[a-z0-9-]+\.)*jobbsys\.no(?=[/?#\"'\s<>]|$)[^\s\"'<>]*",
    re.IGNORECASE,
)

WORKDAY_HOST = re.compile(
    r"https?://([a-z0-9-]+)\.(?:wd\d+\.)?myworkdayjobs\.com(?:/([^?#\"'\s<>]*))?",
    re.IGNORECASE,
)
WORKDAY_CXS = re.compile(
    r"(https?://[^/\s\"'<>]+)/wday/cxs/([^/\s\"'<>]+)/([^/\s\"'<>]+)",
    re.IGNORECASE,
)
WORKDAY_CXS_REL = re.compile(r"/wday/cxs/([^/\s\"'<>]+)/([^/\s\"'<>]+)", re.IGNORECASE)
WORKDAY_ANY = re.compile(r"myworkdayjobs\.com|myworkday\.com|workday\.com", re.IGNORECASE)

OTHER_ATS = (
    ("successfactors", re.compile(r"successfactors\.(?:com|eu)", re.IGNORECASE)),
    ("oraclecloud", re.compile(r"oraclecloud\.com", re.IGNORECASE)),
    ("recruitee", re.compile(r"recruitee\.com", re.IGNORECASE)),
    ("jobylon", re.compile(r"jobylon\.com", re.IGNORECASE)),
    ("recman", re.compile(r"recman\.(?:no|com)", re.IGNORECASE)),
    ("easycruit", re.compile(r"easycruit\.com", re.IGNORECASE)),
    ("icims", re.compile(r"icims\.com", re.IGNORECASE)),
    ("webtemp", re.compile(r"webtemp\.(?:no|com|se)", re.IGNORECASE)),
)

_RANK = {"low": 1, "medium": 2, "high": 3}
_CAREER_WORDS = re.compile(
    r"(jobb|karriere|career|stilling|ledig|vacanc|arbeid|rekrutter|join-us|work-with-us)",
    re.IGNORECASE,
)
_ANCHOR = re.compile(r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", re.IGNORECASE | re.DOTALL)
def _clean_url(url: str) -> str:
    return url.strip().rstrip("\"'<>),.;&")


def _normalise_site(website: str) -> str | None:
    website = (website or "").strip()
    if not website:
        return None
    if not re.match(r"^https?://", website, re.IGNORECASE):
        website = "https://" + website.lstrip("/")
    parts = urlsplit(website)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return website


def _best_detection(detections: list[Detection]) -> Detection | None:
    if not detections:
        return None
    best = detections[0]
    for candidate in detections[1:]:
        if _RANK[candidate.confidence] > _RANK[best.confidence]:
            best = candidate
    return best


_LOCALE_SEGMENT = re.compile(r"[a-z]{2}[-_][a-z]{2}", re.IGNORECASE)
_WORKDAY_NON_SITE = {"job", "jobs", "wday"}


def _workday_site_url(url: str) -> str:
    """Return the public Workday career-site URL (`https://host/<site>`).

    Workday connectors and the registry both expect a full career-site URL;
    a bare `<tenant>/<site>` is not resolvable without the wdN host suffix.
    """
    parts = urlsplit(_clean_url(url))
    segments = [segment for segment in parts.path.split("/") if segment]
    if segments and _LOCALE_SEGMENT.fullmatch(segments[0]):
        segments = segments[1:]
    site = segments[0] if segments and segments[0].lower() not in _WORKDAY_NON_SITE else ""
    base = f"{parts.scheme}://{parts.netloc}"
    return f"{base}/{site}" if site else base


def detect_ats(urls, htmls) -> Detection | None:
    """Recognise a recruitment system in URLs and page HTML.

    Specificity beats frequency: a public feed URL is `high`, a link to an ATS
    domain is `medium`, and an embedded widget name alone is `low`.
    """
    scan = "\n".join([str(url) for url in urls] + [str(html) for html in htmls])
    detections: list[Detection] = []

    match = TEAMTAILOR_RSS.search(scan)
    if match:
        detections.append(
            Detection("teamtailor", _clean_url(match.group(1)), "high", "jobs.rss")
        )
    for match in TEAMTAILOR_HOST.finditer(scan):
        slug = match.group(1).lower()
        if slug in {"www", "api", "support", "help", "blog"}:
            continue
        detections.append(
            Detection(
                "teamtailor",
                f"https://{slug}.teamtailor.com/jobs.rss",
                "high" if "/jobs.rss" in scan else "medium",
                "teamtailor host",
            )
        )

    match = WEB_APPLOCK.search(scan)
    if match:
        confidence = "high" if "companyadverts" in scan.lower() else "medium"
        detections.append(
            Detection("webcruiter", f"companylock={match.group(1)}", confidence, "companylock")
        )
    for match in WEB_HOST.finditer(scan):
        slug = match.group(1).lower()
        if slug in {"www", "candidate", "api"}:
            continue
        detections.append(
            Detection("webcruiter", f"https://{slug}.webcruiter.com", "medium", "webcruiter host")
        )

    reachmee_seen = False
    for match in REACHMEE.finditer(scan):
        url = _clean_url(match.group(0))
        confidence = "high" if "/ext/" in url.lower() else "medium"
        detections.append(Detection("reachmee", url, confidence, "reachmee url"))
        reachmee_seen = True
    if not reachmee_seen and REACHMEE_APP.search(scan):
        detections.append(
            Detection("reachmee", "", "medium", "reachmee application")
        )

    match = SMART_API.search(scan)
    if match:
        detections.append(
            Detection("smartrecruiters", match.group(1), "high", "smartrecruiters api")
        )
    else:
        match = SMART_ANY.search(scan)
        if match:
            url = _clean_url(match.group(0))
            slug_match = re.search(r"/companies/([A-Za-z0-9._-]+)", url, re.IGNORECASE)
            detections.append(
                Detection(
                    "smartrecruiters",
                    slug_match.group(1) if slug_match else "",
                    "medium",
                    "smartrecruiters link",
                )
            )

    match = HR_RSS.search(scan) or HR_SVC.search(scan)
    if match:
        detections.append(
            Detection("hrmanager", f"customer={match.group(1)}", "high", "positionlist rss")
        )
    else:
        match = HR_CUSTOMER.search(scan)
        if match:
            detections.append(
                Detection("hrmanager", f"customer={match.group(1)}", "medium", "hr-manager link")
            )
        else:
            match = HR_CID.search(scan)
            if match:
                detections.append(
                    Detection("hrmanager", f"cid={match.group(1)}", "medium", "hr-manager cid")
                )
            elif re.search(r"hr-manager\.net", scan, re.IGNORECASE):
                detections.append(Detection("hrmanager", "", "medium", "hr-manager link"))

    if JOBNORGE.search(scan):
        detections.append(Detection("jobbnorge", "", "medium", "jobbnorge link"))

    match = VISMA_CAREER.search(scan)
    if match:
        detections.append(
            Detection(
                "vismatalent",
                _clean_url(match.group(0)),
                "high",
                "vismatalent career site",
            )
        )
    else:
        match = VISMA_SITEGUID.search(scan)
        if match:
            detections.append(
                Detection("vismatalent", match.group(1), "medium", "vismatalent GetJobList")
            )
        elif VISMA_HOST.search(scan):
            detections.append(Detection("vismatalent", "", "medium", "vismatalent host"))

    if AVATURE_MARK.search(scan):
        ref = ""
        for candidate in AVATURE_URL.finditer(scan):
            url = _clean_url(candidate.group(0))
            if "avature.net" in url.lower():
                ref = url
                break
        detections.append(Detection("avature", ref, "medium", "avature portal"))

    match = DONEAI_URL.search(scan)
    if match:
        url = _clean_url(match.group(0))
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        path = parts.path.rstrip("/")
        ref = (
            f"{origin}/positions"
            if path == "/positions" or "/positions/" in parts.path
            else origin
        )
        detections.append(Detection("doneai", ref, "medium", "done.ai"))

    match = CAREERHUB_URL.search(scan)
    if match:
        url = _clean_url(match.group(0))
        parts = urlsplit(url)
        ref = url if parts.path and parts.path != "/" else ""
        detections.append(Detection("careerhub", ref, "medium", "careerhub"))

    match = HEARTPACE_URL.search(scan)
    if match:
        url = _clean_url(match.group(0))
        if not re.match(r"^https?://", url, re.IGNORECASE):
            url = "https://" + url
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        ref = url if host.startswith("hiring.") or (parts.path and parts.path != "/") else ""
        confidence = "high" if host.startswith("hiring.") else "medium"
        detections.append(Detection("heartpace", ref, confidence, "heartpace"))

    match = JOBBSYS_URL.search(scan)
    if match:
        url = _clean_url(match.group(0))
        if not re.match(r"^https?://", url, re.IGNORECASE):
            url = "https://" + url
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        ref = url if host not in {"jobbsys.no", "www.jobbsys.no"} or (parts.path and parts.path != "/") else ""
        confidence = "high" if host not in {"jobbsys.no", "www.jobbsys.no"} else "medium"
        detections.append(Detection("jobbsys", ref, confidence, "jobbsys"))

    match = WORKDAY_HOST.search(scan)
    if match:
        detections.append(
            Detection(
                "workday",
                _workday_site_url(match.group(0)),
                "high",
                "myworkdayjobs host",
            )
        )
    else:
        match = WORKDAY_CXS.search(scan)
        if match:
            detections.append(
                Detection(
                    "workday",
                    f"{match.group(1)}/{match.group(3)}",
                    "medium",
                    "wday cxs",
                )
            )
        else:
            relative = WORKDAY_CXS_REL.search(scan)
            if relative:
                origin = ""
                for candidate in urls:
                    parts = urlsplit(str(candidate))
                    if parts.scheme in ("http", "https") and parts.netloc:
                        origin = f"{parts.scheme}://{parts.netloc}"
                        break
                ref = f"{origin}/{relative.group(2)}" if origin else f"{relative.group(1)}/{relative.group(2)}"
                detections.append(Detection("workday", ref, "medium", "wday cxs (relative)"))
            elif WORKDAY_ANY.search(scan):
                detections.append(Detection("workday", "", "medium", "workday link"))

    for ats, pattern in OTHER_ATS:
        if pattern.search(scan):
            detections.append(Detection(ats, "", "low", f"{ats} widget"))

    return _best_detection(detections)


def _is_bot_page(response: Response) -> bool:
    if response.status in (403, 429, 503) and response.text.strip():
        low = response.text.lower()
        if any(marker in low for marker in _BOT_MARKERS):
            return True
    return _looks_like_bot(response.text)


def _robots_match(pattern: str, path: str) -> int:
    """RFC 9309 wildcard match by table walk, so a hostile file cannot ReDoS us."""
    if not pattern:
        return -1
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    reach = [False] * (len(body) + 1)
    reach[0] = True
    for index, char in enumerate(body, 1):
        if char == "*":
            reach[index] = reach[index - 1]
        else:
            break
    if reach[-1] and not anchored:
        return len(pattern)
    for char in path:
        step = [False] * (len(body) + 1)
        for index, pattern_char in enumerate(body, 1):
            if pattern_char == "*":
                step[index] = step[index - 1] or reach[index]
            elif pattern_char == char:
                step[index] = reach[index - 1]
        reach = step
        if reach[-1] and not anchored:
            return len(pattern)
    return len(pattern) if reach[-1] else -1


def _robots_allows(text: str, path: str, agent: str = AGENT_TOKEN) -> bool:
    groups: dict[str, list[tuple[bool, str]]] = {}
    agents: list[str] = []
    saw_rule = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        field, _, value = line.partition(":")
        field, value = field.strip().lower(), value.strip()
        if field == "user-agent":
            if saw_rule:
                agents = []
                saw_rule = False
            agents.append(value.lower())
            for name in agents:
                groups.setdefault(name, [])
        elif field in ("allow", "disallow") and agents:
            saw_rule = True
            for name in agents:
                groups.setdefault(name, []).append((field == "allow", value))

    rules = groups.get(agent.lower())
    if rules is None:
        rules = groups.get("*", [])
    best_length, best_allow = -1, True
    for is_allow, pattern in rules:
        length = _robots_match(pattern, path)
        if length > best_length or (length == best_length and length >= 0 and not is_allow):
            best_length, best_allow = length, is_allow
    return True if best_length < 0 else best_allow


def _robots_allowed(url: str, *, getter, timeout: float, cache: dict, lock) -> bool:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return False
    key = f"{parts.scheme}://{parts.netloc}"
    with lock:
        cached = cache.get(key)
    if cached is None:
        response = get_with_backoff(
            key + "/robots.txt", getter=getter, timeout=timeout, retries=1
        )
        cached = (response.status, response.text)
        with lock:
            cache[key] = cached
    status, text = cached
    if status != 200 or not text.strip():
        return True
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return _robots_allows(text, path)


def _find_career_links(base: str, html: str) -> list[str]:
    links: list[str] = []
    for href, anchor in _ANCHOR.findall(html or ""):
        href = unescape(href)
        if href.lower().startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        text = re.sub(r"<[^>]+>", " ", anchor or "")
        if not _CAREER_WORDS.search(href + " " + text):
            continue
        url = urljoin(base, href)
        if urlsplit(url).scheme not in ("http", "https"):
            continue
        if url.lower().endswith((".pdf", ".doc", ".docx", ".jpg", ".png", ".svg")):
            continue
        if url not in links:
            links.append(url)
    return links


_ATTR_URL = re.compile(
    r"""(?:href|src|data-src|data-href)\s*=\s*["']([^"']+)["']""", re.IGNORECASE
)
_ABS_URL = re.compile(r"https?://[^\s\"'<>\\)\]]+", re.IGNORECASE)
_LISTING_URL = re.compile(
    r"(?:/job/|/jobs/|/stilling(?:er)?(?:/|$|[?#])|/ledige-stillinger(?:/|$|[?#])"
    r"|/positions?(?:/|$|[?#])|/vacanc(?:y|ies)(?:/|$|[?#])|[?&]job_id="
    r"|/jobb-i-|/jobbe-i-|/careers?/)",
    re.IGNORECASE,
)
_APPLY_URL = re.compile(
    r"(?:/apply(?:/|$|[?#])|/application(?:/|$|[?#])|/sok(?:/|$|[?#])"
    r"|/søk(?:/|$|[?#])|/send-application|apply\?)",
    re.IGNORECASE,
)
_KNOWN_ATS_URL = re.compile(
    r"myworkdayjobs\.com|myworkday\.com|vismatalent\.com|avature\.net|avacdn\.net"
    r"|done\.ai|careerhub\.se|heartpace\.com|jobbsys\.no|reachmee\.com|teamtailor\.com|webcruiter\.com"
    r"|smartrecruiters\.com|hr-manager\.net|jobbnorge\.no|successfactors\."
    r"|oraclecloud\.com|recruitee\.com|jobylon\.com|recman\.|easycruit\.com"
    r"|icims\.com|webtemp\.",
    re.IGNORECASE,
)
_SKIP_EXTENSIONS = (
    ".pdf",
    ".doc",
    ".docx",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".svg",
    ".css",
    ".js",
    ".ico",
    ".zip",
)


def _extract_urls(base: str, html: str) -> list[str]:
    """Collect absolute HTTP(S) links from anchors, frames and script tags."""
    links: list[str] = []
    for raw in _ATTR_URL.findall(html or ""):
        raw = unescape(raw)
        if raw.lower().startswith(("mailto:", "tel:", "javascript:", "data:", "#")):
            continue
        url = urljoin(base, raw)
        if urlsplit(url).scheme not in ("http", "https"):
            continue
        if url.lower().split("?", 1)[0].endswith(_SKIP_EXTENSIONS):
            continue
        if url not in links:
            links.append(url)
    return links


_BAD_HOST_CHAR = re.compile(r"""[\s&"'<>\\]|[\x00-\x1f\x7f]""")


def _host_from_url(url: str) -> str:
    """Return a lowercase hostname, or "" for anything that will not parse.

    HTML entities and other URL debris (`foo.com&quot`, `foo.com&`) are not
    real hostnames, so they are rejected instead of polluting the debug field.
    """
    try:
        candidate = unescape(str(url or "").strip())
        host = (urlsplit(candidate).hostname or "").lower()
    except (TypeError, ValueError):
        return ""
    host = host.strip(".")
    if not host or _BAD_HOST_CHAR.search(host):
        return ""
    return host


def _own_hostname(website: str) -> str:
    host = _host_from_url(website)
    return host[4:] if host.startswith("www.") else host


def _is_own_host(host: str, own_host: str) -> bool:
    if not host or not own_host:
        return False
    return host == own_host or host.endswith("." + own_host)


def _collect_third_party_hosts(
    hosts: set[str], base: str, html: str, page_url: str, own_host: str
) -> None:
    """Add external hosts referenced by one fetched page, never raising."""
    urls = [page_url]
    try:
        urls.extend(_extract_urls(base or page_url, html or ""))
    except (TypeError, ValueError):
        pass
    urls.extend(_clean_url(match.group(0)) for match in _ABS_URL.finditer(html or ""))
    for url in urls:
        host = _host_from_url(url)
        if host and not _is_own_host(host, own_host):
            hosts.add(host)


def _third_party_hosts_value(hosts: set[str], limit: int = 20) -> str:
    return "|".join(sorted(hosts)[:limit])


def _is_listing_url(url: str) -> bool:
    return bool(_LISTING_URL.search(url or ""))


def _is_apply_url(url: str) -> bool:
    return bool(_APPLY_URL.search(url or "") or _KNOWN_ATS_URL.search(url or ""))


def _apply_detection(out: dict, detection: Detection | None, *, force: bool) -> None:
    """Fill detected fields without overwriting human-owned values.

    ``ats`` is only filled when it is empty or ``none``. ``ats_ref`` is only
    filled when empty, and only for the system already recorded on the row.
    ``--force`` replaces both regardless.
    """
    current = (out.get("ats") or "").strip().lower()
    existing_ref = (out.get("ats_ref") or "").strip()
    if detection is None:
        if not current:
            out["ats"] = "none"
        return
    if force:
        out["ats"] = detection.ats
        out["ats_ref"] = detection.ref
        out["confidence"] = detection.confidence
        return
    if current in ("", "none"):
        out["ats"] = detection.ats
        if not existing_ref:
            out["ats_ref"] = detection.ref
        out["confidence"] = detection.confidence
    elif current == detection.ats and not existing_ref:
        out["ats_ref"] = detection.ref
        out["confidence"] = detection.confidence


def _discover_one(
    row: dict,
    *,
    getter,
    timeout: float,
    force: bool,
    robots_cache: dict,
    lock,
    max_listings: int = 3,
    max_apply_hops: int = 1,
) -> tuple[dict, dict]:
    out = dict(row)
    website = _normalise_site(out.get("website") or "")
    summary = {"orgnr": out.get("orgnr", ""), "name": out.get("name", ""), "outcome": "skipped"}
    if not website:
        return out, summary
    own_host = _own_hostname(website)
    third_party_hosts: set[str] = set()
    if not _robots_allowed(website, getter=getter, timeout=timeout, cache=robots_cache, lock=lock):
        out["status"] = "blocked"
        summary["outcome"] = "blocked"
        return out, summary

    home = get_with_backoff(website, getter=getter, timeout=timeout, retries=2)
    if home.status == 0:
        summary["outcome"] = "error"
        return out, summary
    if _is_bot_page(home):
        out["status"] = "blocked"
        summary["outcome"] = "blocked"
        return out, summary
    _collect_third_party_hosts(third_party_hosts, home.url, home.text, home.url, own_host)

    detection = detect_ats([home.url, website], [home.text])
    fetched = {home.url.rstrip("/"), website.rstrip("/")}
    pages: list[tuple[str, str]] = [(home.url or website, home.text)]

    career_found = ""
    candidates: list[str] = []
    existing_career = _normalise_site(out.get("career_url") or "")
    if existing_career:
        candidates.append(existing_career)
    for candidate in _find_career_links(home.url, home.text):
        if candidate not in candidates:
            candidates.append(candidate)

    for candidate in candidates[:3]:
        key = candidate.rstrip("/")
        if key in fetched:
            continue
        if not _robots_allowed(candidate, getter=getter, timeout=timeout, cache=robots_cache, lock=lock):
            continue
        response = get_with_backoff(candidate, getter=getter, timeout=timeout, retries=2)
        if _is_bot_page(response):
            out["status"] = "blocked"
            summary["outcome"] = "blocked"
            return out, summary
        if response.status >= 400 or response.status == 0:
            continue
        actual = response.url or candidate
        fetched.update({key, actual.rstrip("/")})
        if not career_found:
            career_found = actual
        pages.append((actual, response.text))
        _collect_third_party_hosts(third_party_hosts, actual, response.text, actual, own_host)
        candidate_detection = detect_ats([actual, candidate], [response.text])
        if candidate_detection and (
            detection is None
            or _RANK[candidate_detection.confidence] > _RANK[detection.confidence]
        ):
            detection = candidate_detection

    listing_queue: list[str] = []
    queued: set[str] = set()
    for base, html in pages:
        for url in _extract_urls(base, html):
            if not _is_listing_url(url):
                continue
            key = url.rstrip("/")
            if key in fetched or key in queued:
                continue
            listing_queue.append(url)
            queued.add(key)

    listing_pages: list[tuple[str, str]] = []
    listing_fetches = 0
    while listing_queue and listing_fetches < max(0, max_listings):
        candidate = listing_queue.pop(0)
        key = candidate.rstrip("/")
        if key in fetched:
            continue
        if not _robots_allowed(candidate, getter=getter, timeout=timeout, cache=robots_cache, lock=lock):
            continue
        listing_fetches += 1
        response = get_with_backoff(candidate, getter=getter, timeout=timeout, retries=2)
        if _is_bot_page(response):
            out["status"] = "blocked"
            summary["outcome"] = "blocked"
            return out, summary
        if response.status >= 400 or response.status == 0:
            continue
        actual = response.url or candidate
        fetched.update({key, actual.rstrip("/")})
        listing_pages.append((actual, response.text))
        _collect_third_party_hosts(third_party_hosts, actual, response.text, actual, own_host)
        listing_detection = detect_ats([actual, candidate], [response.text])
        if listing_detection and (
            detection is None
            or _RANK[listing_detection.confidence] > _RANK[detection.confidence]
        ):
            detection = listing_detection
        for url in _extract_urls(actual, response.text):
            if not _is_listing_url(url):
                continue
            child_key = url.rstrip("/")
            if child_key in fetched or child_key in queued:
                continue
            listing_queue.append(url)
            queued.add(child_key)

    apply_candidates: list[str] = []
    for base, html in listing_pages:
        for url in _extract_urls(base, html):
            if not _is_apply_url(url):
                continue
            if url.rstrip("/") in fetched or url in apply_candidates:
                continue
            apply_candidates.append(url)

    for candidate in apply_candidates[: max(0, max_apply_hops)]:
        key = candidate.rstrip("/")
        if key in fetched:
            continue
        if not _robots_allowed(candidate, getter=getter, timeout=timeout, cache=robots_cache, lock=lock):
            continue
        response = get_with_backoff(candidate, getter=getter, timeout=timeout, retries=2)
        if _is_bot_page(response):
            out["status"] = "blocked"
            summary["outcome"] = "blocked"
            return out, summary
        if response.status >= 400 or response.status == 0:
            continue
        actual = response.url or candidate
        fetched.update({key, actual.rstrip("/")})
        _collect_third_party_hosts(third_party_hosts, actual, response.text, actual, own_host)
        apply_detection = detect_ats([actual, candidate], [response.text])
        if apply_detection and (
            detection is None
            or _RANK[apply_detection.confidence] > _RANK[detection.confidence]
        ):
            detection = apply_detection

    _apply_detection(out, detection, force=force)
    out["third_party_hosts"] = _third_party_hosts_value(third_party_hosts)
    if career_found and (not out.get("career_url") or force):
        out["career_url"] = career_found
    if detection:
        summary["outcome"] = "detected"
        summary["ats"] = detection.ats
        summary["ats_ref"] = detection.ref
    else:
        summary["outcome"] = "none"
    return out, summary


def discover_rows(
    rows: list[dict],
    *,
    top: int = 150,
    timeout: float = 10.0,
    concurrency: int = 4,
    force: bool = False,
    max_listings: int = 3,
    max_apply_hops: int = 1,
    getter=http_get,
) -> tuple[list[dict], dict]:
    """Detect ATSs for the first `top` rows, preserving human-owned values."""
    if concurrency < 1:
        concurrency = 1
    updated = [dict(row) for row in rows]
    targets = updated[:top]
    if not targets:
        return updated, {"processed": 0, "detected": 0, "blocked": 0, "rows": len(updated)}

    import threading
    from concurrent.futures import ThreadPoolExecutor

    cache: dict = {}
    lock = threading.Lock()
    completed: dict[int, tuple[dict, dict]] = {}

    def work(index: int, row: dict):
        return index, _discover_one(
            row,
            getter=getter,
            timeout=timeout,
            force=force,
            robots_cache=cache,
            lock=lock,
            max_listings=max_listings,
            max_apply_hops=max_apply_hops,
        )

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for index, result in pool.map(lambda pair: work(*pair), list(enumerate(targets))):
            completed[index] = result

    detected = 0
    blocked = 0
    details = []
    for index in range(len(targets)):
        row, summary = completed[index]
        updated[index] = row
        if summary["outcome"] == "detected":
            detected += 1
        if summary["outcome"] == "blocked":
            blocked += 1
        details.append(summary)
    return updated, {
        "rows": len(updated),
        "processed": len(targets),
        "detected": detected,
        "blocked": blocked,
        "details": details,
    }


# ---------------------------------------------------------------------------
# probe
# ---------------------------------------------------------------------------

LEGAL_SUFFIXES = {"as", "asa", "sa", "hf", "sf"}
_SLUG_FOLD = str.maketrans(
    {
        "ø": "o",
        "Ø": "O",
        "æ": "ae",
        "Æ": "AE",
        "å": "a",
        "Å": "A",
        "œ": "oe",
        "Œ": "OE",
        "ß": "ss",
        "đ": "d",
        "Đ": "D",
        "ł": "l",
        "Ł": "L",
        "þ": "th",
        "Þ": "TH",
        "ð": "d",
        "Ð": "D",
    }
)


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", str(text or ""))
    folded = decomposed.translate(_SLUG_FOLD)
    return folded.encode("ascii", "ignore").decode("ascii").lower()


def company_slug(name: str) -> str:
    tokens = [token for token in re.split(r"[^a-z0-9]+", _fold(name)) if token]
    while tokens and tokens[-1] in LEGAL_SUFFIXES:
        tokens.pop()
    return "-".join(tokens)


def _slug_candidates(name: str) -> list[str]:
    slug = company_slug(name)
    if not slug:
        return []
    candidates = [slug]
    compact = slug.replace("-", "")
    if compact and compact != slug:
        candidates.append(compact)
    return candidates


def normalize_name(name: str) -> str:
    tokens = [token for token in re.split(r"[^a-z0-9]+", _fold(name)) if token]
    tokens = [token for token in tokens if token not in LEGAL_SUFFIXES]
    text = " ".join(tokens)
    text = re.sub(
        r"^(?:jobs?|job openings|ledige stillinger|karriere)\s+(?:at|hos|i)\s+", "", text
    )
    return text.strip()


def name_matches(feed_name: str, row: dict) -> bool:
    feed = normalize_name(feed_name)
    if not feed:
        return False
    candidates = [row.get("name") or ""]
    candidates.extend(str(row.get("aliases") or "").split("|"))
    for candidate in candidates:
        wanted = normalize_name(candidate)
        if not wanted:
            continue
        if feed == wanted:
            return True
        if re.search(rf"(?:^| ){re.escape(wanted)}(?: |$)", feed):
            return True
        if re.search(rf"(?:^| ){re.escape(feed)}(?: |$)", wanted):
            return True
    return False


def _rss_title(text: str) -> str:
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return ""
    channel = root.find("channel")
    if channel is not None:
        title = channel.findtext("title")
        if title:
            return title
    return root.findtext("title") or ""


def _probe_teamtailor(slug: str, row: dict, *, getter, timeout: float) -> Detection | None:
    url = f"https://{slug}.teamtailor.com/jobs.rss"
    response = get_with_backoff(url, getter=getter, timeout=timeout, retries=1)
    if response.status != 200:
        return None
    title = _rss_title(response.text)
    if name_matches(title, row):
        return Detection("teamtailor", url, "high", "jobs.rss")
    return None


def _probe_smartrecruiters(slug: str, row: dict, *, getter, timeout: float) -> Detection | None:
    url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=1"
    response = get_with_backoff(url, getter=getter, timeout=timeout, retries=1)
    if response.status != 200:
        return None
    try:
        data = json.loads(response.text)
    except (TypeError, json.JSONDecodeError):
        return None
    content = data.get("content") if isinstance(data, dict) else None
    if not isinstance(content, list):
        return None
    for posting in content:
        if not isinstance(posting, dict):
            continue
        company = posting.get("company") or {}
        company_name = ""
        if isinstance(company, dict):
            company_name = company.get("name") or ""
        company_name = company_name or posting.get("companyName") or ""
        if name_matches(company_name, row):
            return Detection("smartrecruiters", slug, "high", "postings api")
    return None


def _probe_hrmanager(slug: str, row: dict, *, getter, timeout: float) -> Detection | None:
    url = (
        "https://api.hr-manager.net/JobPortal.svc/"
        f"{slug}/PositionList/rss/?protype=RecruitmentProject&incads=true"
    )
    response = get_with_backoff(url, getter=getter, timeout=timeout, retries=1)
    if response.status != 200:
        return None
    title = _rss_title(response.text)
    if name_matches(title, row):
        return Detection("hrmanager", f"customer={slug}", "high", "positionlist rss")
    return None


def _probe_reachmee(row: dict, *, getter, timeout: float) -> Detection | None:
    candidate = ""
    for field in ("career_url", "ats_ref"):
        value = (row.get(field) or "").strip()
        if value and "reachmee.com" in value.lower():
            candidate = value if re.match(r"^https?://", value, re.IGNORECASE) else "https://" + value
            break
    if not candidate:
        return None
    response = get_with_backoff(candidate, getter=getter, timeout=timeout, retries=1)
    if response.status != 200:
        return None
    if "reachmee.com" not in (response.url + response.text).lower():
        return None
    haystack = " ".join([_rss_title(response.text), response.text[:20000]])
    if name_matches(haystack, row):
        return Detection("reachmee", candidate, "high", "public list")
    return None


def probe_rows(
    rows: list[dict],
    *,
    top: int = 150,
    timeout: float = 10.0,
    getter=http_get,
) -> tuple[list[dict], dict]:
    """Try public feeds by slug; keep a hit only when the company name matches."""
    updated = [dict(row) for row in rows]
    targets = updated[:top]
    hits = []
    probed = 0

    for row in targets:
        current_ats = (row.get("ats") or "").strip().lower()
        current_ref = (row.get("ats_ref") or "").strip()
        has_system = bool(current_ats and current_ats != "none")
        if current_ref:
            continue
        probed += 1
        slugs: list[str] = []
        for name in [row.get("name") or ""] + str(row.get("aliases") or "").split("|"):
            for slug in _slug_candidates(name):
                if slug and slug not in slugs:
                    slugs.append(slug)
        if not slugs:
            continue

        detection = None
        for slug in slugs:
            detection = _probe_teamtailor(
                slug, row, getter=getter, timeout=timeout
            ) or _probe_smartrecruiters(slug, row, getter=getter, timeout=timeout) or _probe_hrmanager(
                slug, row, getter=getter, timeout=timeout
            )
            if detection:
                break
        if detection is None:
            detection = _probe_reachmee(row, getter=getter, timeout=timeout)
        if detection is None:
            continue

        if not has_system:
            row["ats"] = detection.ats
            row["ats_ref"] = detection.ref
            row["confidence"] = detection.confidence
        elif current_ats == detection.ats and not current_ref:
            row["ats_ref"] = detection.ref
            row["confidence"] = detection.confidence
        else:
            continue
        hits.append(
            {
                "orgnr": row.get("orgnr", ""),
                "name": row.get("name", ""),
                "ats": row.get("ats", ""),
                "ats_ref": row.get("ats_ref", ""),
            }
        )

    return updated, {"rows": len(updated), "probed": probed, "hits": hits}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch = subparsers.add_parser("fetch", help="fetch local units from Brønnøysund")
    fetch.add_argument("--municipalities", default=DEFAULT_MUNICIPALITIES)
    fetch.add_argument("--min-staff", type=int, default=50)
    fetch.add_argument("--out", type=Path, default=DEFAULT_UNITS)
    fetch.add_argument("--size", type=int, default=100)
    fetch.add_argument("--max-pages", type=int, default=None)
    fetch.add_argument("--timeout", type=float, default=15.0)

    rollup = subparsers.add_parser("rollup", help="group units and write the registry CSV")
    rollup.add_argument("--units", type=Path, default=DEFAULT_UNITS)
    rollup.add_argument("--out", type=Path, default=DEFAULT_CSV)
    rollup.add_argument("--seed", type=Path, default=None)
    rollup.add_argument(
        "--preserve-seed",
        action="store_true",
        help="append every seed row not in the computed top N (keeps curated ATS employers)",
    )
    rollup.add_argument("--top", type=int, default=150)

    merge = subparsers.add_parser(
        "merge", help="merge curated seed CSV files into a working registry"
    )
    merge.add_argument("--base", type=Path, default=DEFAULT_CSV)
    merge.add_argument(
        "--seed",
        type=Path,
        action="append",
        required=True,
        help="seed CSV to merge; repeat for multiple files",
    )
    merge.add_argument("--out", type=Path, default=DEFAULT_CSV)
    merge.add_argument(
        "--enable-relevance",
        action="store_true",
        help="derive enabled from relevance for newly appended rows only",
    )

    discover = subparsers.add_parser("discover", help="detect ATSs from employer websites")
    discover.add_argument("--in", "--input", dest="input", type=Path, default=DEFAULT_CSV)
    discover.add_argument("--out", type=Path, default=None)
    discover.add_argument("--top", type=int, default=150)
    discover.add_argument("--timeout", type=float, default=10.0)
    discover.add_argument("--concurrency", type=int, default=4)
    discover.add_argument(
        "--listings",
        dest="max_listings",
        type=int,
        default=3,
        help="maximum job-listing pages to follow per employer (default: 3)",
    )
    discover.add_argument(
        "--apply-hops",
        dest="max_apply_hops",
        type=int,
        default=1,
        help="maximum apply links to follow per employer (default: 1)",
    )
    discover.add_argument("--force", action="store_true")

    probe = subparsers.add_parser("probe", help="probe public feeds by company slug")
    probe.add_argument("--in", "--input", dest="input", type=Path, default=DEFAULT_CSV)
    probe.add_argument("--out", type=Path, default=None)
    probe.add_argument("--top", type=int, default=150)
    probe.add_argument("--timeout", type=float, default=10.0)

    rebuild = subparsers.add_parser(
        "rebuild",
        help="one command: fetch -> rollup -> discover -> probe",
    )
    rebuild.add_argument("--municipalities", default=DEFAULT_MUNICIPALITIES)
    rebuild.add_argument("--min-staff", type=int, default=50)
    rebuild.add_argument("--units", type=Path, default=DEFAULT_UNITS)
    rebuild.add_argument("--out", type=Path, default=DEFAULT_CSV)
    rebuild.add_argument("--seed", type=Path, default=None)
    rebuild.add_argument(
        "--preserve-seed",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="keep every seed row not in the computed top N (default: true)",
    )
    rebuild.add_argument("--top", type=int, default=150)
    rebuild.add_argument("--size", type=int, default=100)
    rebuild.add_argument("--max-pages", type=int, default=None)
    rebuild.add_argument("--timeout", type=float, default=15.0)
    rebuild.add_argument("--concurrency", type=int, default=4)
    rebuild.add_argument("--listings", dest="max_listings", type=int, default=3)
    rebuild.add_argument("--apply-hops", dest="max_apply_hops", type=int, default=1)
    rebuild.add_argument("--force", action="store_true")

    return parser


def main(argv=None) -> int:
    _force_utf8_output()
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "fetch":
            summary = fetch_units(
                municipalities=args.municipalities,
                min_staff=args.min_staff,
                out=args.out,
                size=args.size,
                max_pages=args.max_pages,
                timeout=args.timeout,
            )
        elif args.command == "rollup":
            summary = rollup_units(
                units_path=args.units,
                out=args.out,
                seed_path=args.seed,
                top=args.top,
                preserve_seed=args.preserve_seed,
            )
        elif args.command == "merge":
            base_rows = read_csv(args.base)
            seed_rows: list[dict] = []
            for seed_path in args.seed:
                seed_rows.extend(read_csv(seed_path))
            rows, summary = merge_rows(
                base_rows, seed_rows, enable_relevance=args.enable_relevance
            )
            write_csv_atomic(
                args.out, rows, lineterminator=_detect_line_terminator(args.base)
            )
            summary["out"] = str(args.out)
        elif args.command == "discover":
            rows = read_csv(args.input)
            out_path = args.out or args.input
            updated, summary = discover_rows(
                rows,
                top=args.top,
                timeout=args.timeout,
                concurrency=args.concurrency,
                force=args.force,
                max_listings=args.max_listings,
                max_apply_hops=args.max_apply_hops,
            )
            write_csv_atomic(out_path, updated)
            summary["out"] = str(out_path)
        elif args.command == "probe":
            rows = read_csv(args.input)
            out_path = args.out or args.input
            updated, summary = probe_rows(rows, top=args.top, timeout=args.timeout)
            write_csv_atomic(out_path, updated)
            summary["out"] = str(out_path)
        elif args.command == "rebuild":
            seed = args.seed or (DEFAULT_SEED if DEFAULT_SEED.exists() else None)
            fetch_summary = fetch_units(
                municipalities=args.municipalities,
                min_staff=args.min_staff,
                out=args.units,
                size=args.size,
                max_pages=args.max_pages,
                timeout=args.timeout,
            )
            rollup_summary = rollup_units(
                units_path=args.units,
                out=args.out,
                seed_path=seed,
                top=args.top,
                preserve_seed=args.preserve_seed,
            )
            rows = read_csv(args.out)
            updated, discover_summary = discover_rows(
                rows,
                top=args.top,
                timeout=args.timeout,
                concurrency=args.concurrency,
                force=args.force,
                max_listings=args.max_listings,
                max_apply_hops=args.max_apply_hops,
            )
            write_csv_atomic(args.out, updated)
            updated, probe_summary = probe_rows(updated, top=args.top, timeout=args.timeout)
            write_csv_atomic(args.out, updated)
            summary = {
                "out": str(args.out),
                "fetch": fetch_summary,
                "rollup": rollup_summary,
                "discover": discover_summary,
                "probe": probe_summary,
            }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"employer_registry: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
