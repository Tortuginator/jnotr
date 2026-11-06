"""Offline tests for the Trondheim employer registry tool."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import employer_registry as er  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "employer_registry"
REGISTRY = er.REGISTRY_BASE


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def make_row(**overrides) -> dict:
    row = {column: "" for column in er.COLUMNS}
    row.update({"orgnr": "1", "name": "Acme AS", "ats": "none", "enabled": "true"})
    row.update(overrides)
    return row


class MapGetter:
    """Serve recorded fixtures by exact URL, or a 404 for anything else."""

    def __init__(self, mapping, default_status=404):
        self.mapping = dict(mapping)
        self.default_status = default_status
        self.calls = []

    def __call__(self, url, timeout=10.0):
        self.calls.append(url)
        value = self.mapping.get(url)
        if value is None:
            return er.Response(url, self.default_status, "", {})
        if isinstance(value, er.Response):
            return value
        if isinstance(value, tuple):
            status, text = value
            return er.Response(url, status, text, {})
        return er.Response(url, 200, value, {})


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root / "brreg_units.json"

    def fetch_getter(self):
        mapping = {
            f"{REGISTRY}/underenheter?kommunenummer=5001&fraAntallAnsatte=50&size=100&page=0": fixture(
                "underenheter_5001_p0.json"
            ),
            f"{REGISTRY}/underenheter?kommunenummer=5001&fraAntallAnsatte=50&size=100&page=1": fixture(
                "underenheter_5001_p1.json"
            ),
            f"{REGISTRY}/underenheter?kommunenummer=5031&fraAntallAnsatte=50&size=100&page=0": fixture(
                "underenheter_5031_p0.json"
            ),
            f"{REGISTRY}/enheter/800000001": fixture("enheter_800000001.json"),
            f"{REGISTRY}/enheter/800000002": fixture("enheter_800000002.json"),
            f"{REGISTRY}/enheter/700000001": fixture("enheter_700000001.json"),
        }
        return MapGetter(mapping)

    def test_fetch_pages_dedupes_units_and_writes_snapshot(self):
        getter = self.fetch_getter()
        summary = er.fetch_units(
            municipalities="5001,5031",
            min_staff=50,
            out=self.out,
            size=100,
            max_pages=2,
            getter=getter,
            sleep=lambda _seconds: None,
        )

        snapshot = json.loads(self.out.read_text(encoding="utf-8"))
        units = {unit["orgnr"]: unit for unit in snapshot["units"]}
        self.assertEqual(sorted(units), ["900000001", "900000002", "900000003", "900000004"])
        self.assertEqual(units["900000001"]["municipality"], "5001")
        self.assertEqual(units["900000001"]["name"], "ALPHA AS")
        self.assertEqual(units["900000003"]["parent_name"], "BETA HOLDING AS")
        self.assertEqual(
            units["900000003"]["parents"],
            [
                {"orgnr": "800000002", "name": "BETA HOLDING AS"},
                {"orgnr": "700000001", "name": "NÆRINGS- OG FISKERIDEPARTEMENTET"},
            ],
        )
        self.assertIn("fetched_at", snapshot)
        self.assertEqual(summary["units"], 4)
        self.assertEqual(summary["pages_fetched"], 3)
        self.assertEqual(summary["by_municipality"], {"5001": 3, "5031": 1})

    def test_fetch_stops_on_empty_page_and_404(self):
        mapping = {
            f"{REGISTRY}/underenheter?kommunenummer=5001&fraAntallAnsatte=50&size=100&page=0": (
                404,
                "",
            ),
        }
        summary = er.fetch_units(
            municipalities="5001",
            out=self.out,
            getter=MapGetter(mapping),
            sleep=lambda _seconds: None,
        )
        self.assertEqual(summary["units"], 0)
        self.assertEqual(summary["pages_fetched"], 0)


class RollupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.units = FIXTURES / "rollup_units.json"
        self.seed = FIXTURES / "seed_merge.csv"

    def test_groups_units_ranks_by_staff_and_stops_below_ministries(self):
        data = json.loads(self.units.read_text(encoding="utf-8"))
        rows = er.rank_units(data["units"])

        self.assertEqual(
            [row["name"] for row in rows],
            ["SOLO KOMMUNE", "MILJØDIREKTORATET", "ST. OLAVS HOSPITAL HF", "ACME AS"],
        )
        self.assertEqual([row["trd_staff"] for row in rows], [500, 300, 250, 100])
        self.assertFalse(any("DEPARTEMENT" in row["name"] for row in rows))
        acme = rows[-1]
        self.assertEqual(acme["orgnr"], "8001")
        self.assertEqual(acme["nace"], "62.010")
        self.assertIn("ACME TRONDHEIM", acme["aliases"])
        self.assertIn("ACME OSLO", acme["aliases"])
        self.assertEqual(acme["ats"], "none")
        self.assertEqual(acme["enabled"], "true")

    def test_seed_merge_preserves_manual_values(self):
        out = self.root / "employers.csv"
        er.rollup_units(units_path=self.units, out=out, seed_path=self.seed, top=4)
        rows = {row["orgnr"]: row for row in er.read_csv(out)}

        acme = rows["8001"]
        self.assertEqual(acme["name"], "ACME AS")
        self.assertEqual(acme["trd_staff"], "100")
        self.assertEqual(acme["ats"], "webcruiter")
        self.assertEqual(acme["ats_ref"], "companylock=42")
        self.assertEqual(acme["confidence"], "high")
        self.assertEqual(acme["enabled"], "false")
        self.assertEqual(acme["website"], "www.acme.no")
        self.assertEqual(acme["career_url"], "https://acme.no/jobs")
        self.assertIn("ACME TRONDHEIM", acme["aliases"])
        self.assertIn("Acme Group", acme["aliases"])

    def test_seed_fills_a_short_ranking(self):
        out = self.root / "employers.csv"
        er.rollup_units(units_path=self.units, out=out, seed_path=self.seed, top=5)
        rows = er.read_csv(out)
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[-1]["orgnr"], "9999")
        self.assertEqual(rows[-1]["ats"], "jobbnorge")

    def test_preserve_seed_keeps_rows_outside_the_top_n(self):
        out = self.root / "employers.csv"
        er.rollup_units(
            units_path=self.units, out=out, seed_path=self.seed, top=4, preserve_seed=True
        )
        rows = er.read_csv(out)
        self.assertGreater(len(rows), 4)
        self.assertIn("9999", {row["orgnr"] for row in rows})
        self.assertEqual(rows[-1]["orgnr"], "9999")
        self.assertEqual(rows[-1]["ats"], "jobbnorge")


class CsvTests(unittest.TestCase):
    def test_header_order_and_atomic_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "employers.csv"
            er.write_csv_atomic(path, [make_row(orgnr="1", name="Acme AS")])

            first_line = path.read_text(encoding="utf-8").splitlines()[0]
            self.assertEqual(first_line, ",".join(er.COLUMNS))
            self.assertEqual(list(root.glob(".*.tmp")), [])
            loaded = er.read_csv(path)
            self.assertEqual(loaded[0]["orgnr"], "1")
            self.assertEqual(loaded[0]["enabled"], "true")


class DiscoverTests(unittest.TestCase):
    def discover(
        self,
        career_fixture,
        row=None,
        robots=None,
        home="homepage_with_career.html",
        extra=None,
        force=False,
        max_listings=2,
        max_apply_hops=1,
    ):
        mapping = {
            "https://acme.test/robots.txt": robots or fixture("robots_allow.txt"),
            "https://acme.test/": fixture(home),
            "https://acme.test/karriere": fixture(career_fixture),
        }
        if extra:
            mapping.update(extra)
        getter = MapGetter(mapping)
        rows = [row or make_row(website="https://acme.test/")]
        updated, summary = er.discover_rows(
            rows,
            top=1,
            timeout=1.0,
            concurrency=1,
            force=force,
            max_listings=max_listings,
            max_apply_hops=max_apply_hops,
            getter=getter,
        )
        return updated[0], summary, getter

    def test_detects_teamtailor_feed(self):
        row, summary, _ = self.discover("career_teamtailor.html")
        self.assertEqual(row["ats"], "teamtailor")
        self.assertEqual(row["ats_ref"], "https://acme.teamtailor.com/jobs.rss")
        self.assertEqual(row["confidence"], "high")
        self.assertEqual(row["career_url"], "https://acme.test/karriere")
        self.assertEqual(summary["detected"], 1)

    def test_detects_webcruiter_company_lock(self):
        row, _, _ = self.discover("career_webcruiter.html")
        self.assertEqual(row["ats"], "webcruiter")
        self.assertEqual(row["ats_ref"], "companylock=9876")
        self.assertEqual(row["confidence"], "high")

    def test_detects_smartrecruiters_slug(self):
        row, _, _ = self.discover("career_smartrecruiters.html")
        self.assertEqual(row["ats"], "smartrecruiters")
        self.assertEqual(row["ats_ref"], "acme")
        self.assertEqual(row["confidence"], "high")

    def test_detects_hrmanager_customer(self):
        row, _, _ = self.discover("career_hrmanager.html")
        self.assertEqual(row["ats"], "hrmanager")
        self.assertEqual(row["ats_ref"], "customer=acme")
        self.assertEqual(row["confidence"], "high")

    def test_detects_jobbnorge_without_reference(self):
        row, _, _ = self.discover("career_jobbnorge.html")
        self.assertEqual(row["ats"], "jobbnorge")
        self.assertEqual(row["ats_ref"], "")
        self.assertEqual(row["confidence"], "medium")

    def test_manual_ats_is_preserved_without_force(self):
        manual = make_row(
            website="https://acme.test/",
            ats="webcruiter",
            ats_ref="companylock=manual",
            confidence="high",
            enabled="false",
        )
        row, _, _ = self.discover("career_teamtailor.html", row=manual)
        self.assertEqual(row["ats"], "webcruiter")
        self.assertEqual(row["ats_ref"], "companylock=manual")
        self.assertEqual(row["enabled"], "false")

    def test_bot_page_is_recorded_as_blocked_without_retry(self):
        row, summary, getter = self.discover(
            "career_teamtailor.html", home="homepage_blocked.html"
        )
        self.assertEqual(row["status"], "blocked")
        self.assertEqual(row["ats"], "none")
        self.assertEqual(summary["blocked"], 1)
        self.assertNotIn("https://acme.test/karriere", getter.calls)

    def test_robots_disallow_blocks_the_site(self):
        row, summary, getter = self.discover(
            "career_teamtailor.html", robots=fixture("robots_disallow.txt")
        )
        self.assertEqual(row["status"], "blocked")
        self.assertEqual(summary["blocked"], 1)
        self.assertNotIn("https://acme.test/", getter.calls)

    def test_follows_career_listing_and_apply_to_workday(self):
        row, summary, getter = self.discover(
            "career_workday_listing.html",
            extra={
                "https://acme.test/job/123": fixture("listing_workday.html"),
                "https://acme.test/apply/123": fixture("apply_workday.html"),
            },
        )
        self.assertIn("https://acme.test/job/123", getter.calls)
        self.assertIn("https://acme.test/apply/123", getter.calls)
        self.assertEqual(row["ats"], "workday")
        self.assertEqual(row["ats_ref"], "https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site")
        self.assertEqual(row["confidence"], "high")
        self.assertEqual(summary["detected"], 1)

    def test_detects_workday_cxs_script(self):
        row, _, _ = self.discover("career_workday_cxs.html")
        self.assertEqual(row["ats"], "workday")
        self.assertEqual(row["ats_ref"], "https://acme.test/Acme_Careers")
        self.assertEqual(row["confidence"], "medium")

    def test_detects_visma_talent_career_site(self):
        row, _, _ = self.discover("career_vismatalent.html")
        self.assertEqual(row["ats"], "vismatalent")
        self.assertEqual(
            row["ats_ref"],
            "https://hire.vismatalent.com/spa/nb/public/careers/"
            "0ceb6ff0-777f-4216-93b6-be2d4ae34a16",
        )
        self.assertEqual(row["confidence"], "high")

    def test_detects_reachmee_from_listing_apply_link(self):
        row, _, _ = self.discover(
            "career_workday_listing.html",
            extra={"https://acme.test/job/123": fixture("listing_reachmee.html")},
        )
        self.assertEqual(row["ats"], "reachmee")
        self.assertEqual(row["ats_ref"], "")
        self.assertEqual(row["confidence"], "medium")

    def test_detects_avature_from_cdn_markup(self):
        row, _, _ = self.discover("career_avature.html")
        self.assertEqual(row["ats"], "avature")
        self.assertEqual(row["ats_ref"], "")
        self.assertEqual(row["confidence"], "medium")

    def test_detects_doneai_from_career_markup(self):
        row, _, _ = self.discover("career_doneai.html")
        self.assertEqual(row["ats"], "doneai")
        self.assertEqual(row["ats_ref"], "https://recruiting.done.ai/positions")
        self.assertEqual(row["confidence"], "medium")

    def test_detects_careerhub_from_career_markup(self):
        row, _, _ = self.discover("career_careerhub.html")
        self.assertEqual(row["ats"], "careerhub")
        self.assertEqual(row["ats_ref"], "https://my.careerhub.se/acme/jobs")
        self.assertEqual(row["confidence"], "medium")

    def test_caps_listing_and_apply_fetches(self):
        extra = {
            f"https://acme.test/job/{index}": fixture("listing_many_apply.html")
            for index in range(1, 6)
        }
        row, _, getter = self.discover(
            "career_many_listings.html",
            extra=extra,
            max_listings=2,
            max_apply_hops=1,
        )
        listing_calls = [url for url in getter.calls if "/job/" in url]
        apply_calls = [url for url in getter.calls if "/apply/" in url]
        self.assertEqual(len(listing_calls), 2)
        self.assertEqual(len(apply_calls), 1)
        self.assertEqual(row["ats"], "none")

    def test_robots_disallowed_listing_is_not_fetched(self):
        row, _, getter = self.discover(
            "career_many_listings.html",
            robots=fixture("robots_disallow_listing.txt"),
            extra={
                "https://acme.test/job/1": fixture("listing_many_apply.html"),
                "https://acme.test/apply/a": fixture("homepage_with_career.html"),
            },
        )
        self.assertNotIn("https://acme.test/job/1", getter.calls)
        self.assertFalse(any("/apply/" in url for url in getter.calls))
        self.assertEqual(row["ats"], "none")
        self.assertEqual(row["status"], "")

    def test_bot_listing_page_is_recorded_as_blocked(self):
        row, summary, getter = self.discover(
            "career_many_listings.html",
            extra={"https://acme.test/job/1": fixture("homepage_blocked.html")},
        )
        self.assertEqual(row["status"], "blocked")
        self.assertEqual(summary["blocked"], 1)
        self.assertFalse(any("/apply/" in url for url in getter.calls))

    def test_manual_ref_survives_detection_without_force(self):
        manual = make_row(
            website="https://acme.test/",
            ats="none",
            ats_ref="manual-ref",
        )
        row, _, _ = self.discover("career_teamtailor.html", row=manual)
        self.assertEqual(row["ats"], "teamtailor")
        self.assertEqual(row["ats_ref"], "manual-ref")

    def test_force_overrides_manual_ats_and_ref(self):
        manual = make_row(
            website="https://acme.test/",
            ats="webcruiter",
            ats_ref="companylock=manual",
            confidence="high",
            enabled="false",
        )
        row, _, _ = self.discover("career_teamtailor.html", row=manual, force=True)
        self.assertEqual(row["ats"], "teamtailor")
        self.assertEqual(row["ats_ref"], "https://acme.teamtailor.com/jobs.rss")
        self.assertEqual(row["confidence"], "high")
        self.assertEqual(row["enabled"], "false")


class ProbeTests(unittest.TestCase):
    def mapping(self):
        return {
            "https://hent.teamtailor.com/jobs.rss": fixture("teamtailor_hent.rss"),
            "https://other.teamtailor.com/jobs.rss": fixture("teamtailor_other.rss"),
            "https://api.smartrecruiters.com/v1/companies/acme/postings?limit=1": fixture(
                "smartrecruiters_acme.json"
            ),
            "https://api.smartrecruiters.com/v1/companies/other/postings?limit=1": fixture(
                "smartrecruiters_other.json"
            ),
            "https://api.hr-manager.net/JobPortal.svc/acme/PositionList/rss/"
            "?protype=RecruitmentProject&incads=true": fixture("hrmanager_acme.rss"),
        }

    def test_probe_keeps_only_matching_company_names(self):
        rows = [
            make_row(orgnr="1", name="HENT AS"),
            make_row(orgnr="2", name="OTHER AS"),
            make_row(orgnr="3", name="ACME AS", ats="smartrecruiters", ats_ref=""),
        ]
        updated, summary = er.probe_rows(
            rows, top=3, timeout=1.0, getter=MapGetter(self.mapping())
        )

        self.assertEqual(updated[0]["ats"], "teamtailor")
        self.assertEqual(updated[0]["ats_ref"], "https://hent.teamtailor.com/jobs.rss")
        self.assertEqual(updated[0]["confidence"], "high")
        self.assertEqual(updated[1]["ats"], "none")
        self.assertEqual(updated[1]["ats_ref"], "")
        self.assertEqual(updated[2]["ats"], "smartrecruiters")
        self.assertEqual(updated[2]["ats_ref"], "acme")
        self.assertEqual([hit["orgnr"] for hit in summary["hits"]], ["1", "3"])
        self.assertEqual(summary["probed"], 3)

    def test_probe_preserves_a_manual_reference(self):
        manual = make_row(
            orgnr="1",
            name="HENT AS",
            ats="teamtailor",
            ats_ref="https://manual.example/jobs",
        )
        updated, summary = er.probe_rows(
            [manual], top=1, timeout=1.0, getter=MapGetter(self.mapping())
        )
        self.assertEqual(updated[0]["ats_ref"], "https://manual.example/jobs")
        self.assertEqual(summary["probed"], 0)


if __name__ == "__main__":
    unittest.main()

class RebuildCommandTests(unittest.TestCase):
    def test_rebuild_runs_fetch_rollup_discover_probe_in_order(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            out = root / "employers.csv"

            def fake_fetch(**kwargs):
                calls.append("fetch")
                return {"units": 1}

            def fake_rollup(**kwargs):
                calls.append("rollup")
                er.write_csv_atomic(out, [make_row(orgnr="1", name="Acme AS")])
                return {"employers": 1}

            def fake_discover(rows, **kwargs):
                calls.append("discover")
                return rows, {"processed": len(rows), "detected": 0}

            def fake_probe(rows, **kwargs):
                calls.append("probe")
                return rows, {"probed": 0, "hits": []}

            with mock.patch.object(er, "fetch_units", side_effect=fake_fetch), \
                 mock.patch.object(er, "rollup_units", side_effect=fake_rollup), \
                 mock.patch.object(er, "discover_rows", side_effect=fake_discover), \
                 mock.patch.object(er, "probe_rows", side_effect=fake_probe), \
                 contextlib.redirect_stdout(io.StringIO()) as stdout:
                code = er.main([
                    "rebuild",
                    "--units", str(root / "units.json"),
                    "--out", str(out),
                    "--seed", str(FIXTURES / "seed_merge.csv"),
                    "--top", "4",
                ])
            self.assertEqual(code, 0)
            self.assertEqual(calls, ["fetch", "rollup", "discover", "probe"])
            summary = json.loads(stdout.getvalue())
            self.assertEqual(summary["out"], str(out))
            self.assertIn("fetch", summary)
