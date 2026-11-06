# Visma Talent URL Reference

Verified live on **6 November 2026** against the Nortura SA registry row
(`ats=vismatalent`) and the public career site
`https://hire.vismatalent.com/spa/nb/public/careers/0ceb6ff0-777f-4216-93b6-be2d4ae34a16`.

## Access note and robots.txt

`https://hire.vismatalent.com/robots.txt` returned:

```
User-agent: MJ12bot
Disallow: /

User-agent: *
Allow: /$
Allow: /spa/*/public/apply
Allow: /spa/public/apply
Allow: /External/OJCustomer3/AssignmentView.aspx
Allow: /Upload/MediaBank/
Disallow: /
```

The public JSON API paths used by this skill are **not** in the allow list, so
generic automated access is disallowed. This skill is for low-volume personal
job search only. Keep request volume low, do not use it commercially or for
bulk collection, and review Visma's terms before running it. Do not treat this
document as permission to crawl.

The career-site SPA shell did not link a standalone public terms or privacy page
(checked 6 Nov 2026), so `robots.txt` is the only machine-readable access rule
found. If a Visma Talent customer agreement or terms page is supplied later,
record it here before enabling higher-volume use.

## Career site metadata

```
GET https://hire.vismatalent.com/Services/Public/CareerSites/GetCareerSite?siteGuid=<siteGuid>
```

Used only for reconnaissance. It returns site metadata (`Guid`, `Name`,
colours, fonts and content blocks). The `siteGuid` is the same GUID embedded in
the public career URL. Nothing in this response is a job.

## Job list (the endpoint the skill uses)

```
GET https://hire.vismatalent.com/Services/Public/CareerSites/GetJobList?siteGuid=<siteGuid>
```

- No authentication, no query parameters beyond `siteGuid`.
- Returns a JSON **array** of jobs. The response observed for Nortura was
  `200`, about 11 KB, with four jobs.
- The array already contains the full HTML `Assignment.Description`; detail does
  not need to parse the SPA shell.

Verified request:

```bash
curl -sS \
  -A 'Mozilla/5.0 (compatible; vismatalent-search-cli/1.0)' \
  'https://hire.vismatalent.com/Services/Public/CareerSites/GetJobList?siteGuid=0ceb6ff0-777f-4216-93b6-be2d4ae34a16'
```

## Job object schema (observed 6 Nov 2026)

```json
{
  "Guid": "821f710e-4079-45b1-a3b1-27b410df725d",
  "RefNo": "N-2026/88",
  "PublishStartDate": "2026-11-02T23:00:00",
  "PublishEndDate": "2026-11-30T22:59:59",
  "Assignment": {
    "Title": "Linjeleder kantine",
    "Description": "<p>...</p>",
    "LocId": "19",
    "LocName": "nb-NO",
    "Municipality": { "Id": "705", "Name": "Stavanger" },
    "County": { "Id": "272", "Name": "Rogaland" },
    "Country": { "Name": "Norge" },
    "EmploymentType": { "Id": "1", "Name": "Fast ansettelse" },
    "Departments": {
      "Department": { "Id": "3563", "ParentId": "3129", "Level": "2", "Name": "Forus" }
    }
  }
}
```

Field notes:

| Field | Use |
|-------|-----|
| `Guid` | Job GUID; result id is `<siteGuid>:<Guid>` |
| `RefNo` | Employer reference, shown in detail |
| `PublishStartDate` | Result `date`, ISO date prefix (`YYYY-MM-DD`) |
| `PublishEndDate` | Detail `endDate` |
| `Assignment.Title` | Result title |
| `Assignment.Description` | HTML body; converted to readable text for search and detail |
| `Assignment.Municipality.Name` | Display location (first choice) |
| `Assignment.County.Name` | Display fallback; also used for `-l` matching |
| `Assignment.Country.Name` | Display fallback; also used for `-l` matching |
| `Assignment.LocName` | Language code (`nb-NO` in every live job) — matched but not displayed |
| `Assignment.EmploymentType.Name` | Detail employment type |
| `Assignment.Departments.Department` | Object or array; names joined for detail and location matching |

Live Nortura jobs on 6 Nov 2026 (none in Trondheim):

| Title | Municipality | County | Published |
|-------|--------------|--------|-----------|
| Linjeleder kantine | Stavanger | Rogaland | 2026-11-02 |
| Vedlikeholdstekniker | Tønsberg | Vestfold | 2026-10-29 |
| Kundekonsulent (vikariat) – Nortura Proff, region Vest | Bergen | Vestland | 2026-10-27 |
| Vi søker vår neste slakter | Eigersund | Rogaland | 2026-10-20 |

## Registry `ats_ref` forms

| Form | Example | Resolution |
|------|---------|------------|
| Career URL ending in the site GUID | `https://hire.vismatalent.com/spa/nb/public/careers/0ceb6ff0-777f-4216-93b6-be2d4ae34a16` | last path segment |
| Bare site GUID | `0ceb6ff0-777f-4216-93b6-be2d4ae34a16` | the GUID itself |

Rows with an empty `ats_ref` are reported in `meta.errors`; the skill does not
guess a site.

## Public posting URL

```
https://hire.vismatalent.com/Public/Assignment.aspx?guidAssignment=<jobGuid>&language=nb
```

This URL serves the Angular SPA shell, not server-rendered job content. The
skill therefore never parses it: `detail` reuses `GetJobList` for the site and
finds the GUID there.

## Detail target forms

| Input | Resolution |
|-------|------------|
| `<siteGuid>:<jobGuid>` | Fetch that site's job list |
| bare `<jobGuid>` | Fetch every enabled registry site; error `AMBIGUOUS_ID` if more than one contains it |
| URL with `guidAssignment` and a `siteGuid` query parameter | Use that site |
| URL with `guidAssignment` and a `/careers/<siteGuid>` path segment | Use that site |
| URL with only `guidAssignment` | Resolve like a bare GUID across registry sites |

Only `hire.vismatalent.com`/`*.vismatalent.com` URLs are accepted. A malformed
target exits 1 with `BAD_ID`; a missing job exits 1 with `NOT_FOUND`.

## Failure behaviour

- `404` or an empty job list → no results; detail returns `NOT_FOUND`.
- `429`/`5xx` and network errors → exponential backoff with jitter, up to six
  retries.
- A failing employer is recorded in `meta.errors` and never fails the whole
  search run.
- A malformed or unexpected response body counts as a per-employer error.
- The parser ignores unknown extra fields and survives a missing `Assignment`;
  a job without `Guid` is skipped.
