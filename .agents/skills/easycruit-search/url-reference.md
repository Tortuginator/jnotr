# EasyCruit URL reference

Verified live **6 November 2026** against `https://stjordal.easycruit.com`,
`https://tbrt.easycruit.com` and `https://bi.easycruit.com`. All requests use
`Mozilla/5.0 (compatible; easycruit-search-cli/1.0)`.

## Site model

An employer career site is `https://<slug>.easycruit.com` (for example
`https://stjordal.easycruit.com`). The slug is the first host label and is what
the CLI stores in a result id: `<slug>/<vacancyId>`, e.g. `stjordal/3673377`.

`robots.txt` on all three sites returned:

```
User-agent: *
Disallow: /intranet/
Allow: /
```

The root page and the normal HTML search/list page sit behind an AWS WAF
JavaScript challenge (HTTP 202). The CLI **does not** solve or bypass it. The
public feeds and detail paths below returned HTTP 200 without a challenge.

## Endpoints

### 1. RSS feed — descriptions

```
GET https://<slug>.easycruit.com/rss
```

HTTP 200, `Content-Type: application/rss+xml`. RSS 2.0:

```xml
<rss version="2.0">
  <channel>
    <title>Available vacancies</title>
    <link>http://<slug>.easycruit.com</link>
    <pubDate>Fri, 06 Nov 2026 14:14:56 +0000</pubDate>
    <item>
      <title>Ledig 0-hjemmel for fastlege ved Skatval legekontor</title>
      <link>http://<slug>.easycruit.com/vacancy/3673377</link>
      <description>&lt;p&gt;…full HTML, escaped…&lt;/p&gt;</description>
    </item>
  </channel>
</rss>
```

| Field | Behaviour |
|---|---|
| `<title>` | Vacancy title. Reliable. |
| `<description>` | Full description as escaped HTML. Reliable. |
| `<link>` | **Quirk: identical for every item.** On all three sites, every item's `<link>` was the first vacancy's URL. Do not use it as a unique ID. |
| `<pubDate>` | Only on `<channel>`. There is **no per-item `pubDate`**. |

There is also `GET /rss/vacancies`, which returns the same feed. The CLI ignores
the RSS `<link>` for identity and joins descriptions to the XML joblist by
normalised title.

The feed can be **partial**. On 6 Nov 2026 BI's `/rss` returned 4 items while
its XML joblist returned 14 vacancies (the PhD roles were absent). Search only
reads RSS when `-q` is supplied, and falls back to the detail endpoint for
description-only matches that the feed does not cover.

### 2. XML joblist — IDs, titles, dates, workplace

```
GET https://<slug>.easycruit.com/export/xml/vacancy/list.xml
```

HTTP 200, `Content-Type: application/xml`. One `<Vacancy>` per posting:

```xml
<VacancyList generated="2026-11-06T14:15:36" xmlns="urn:EasyCruit">
  <Vacancy id="3672463"
           date_start="2026-10-27"
           date_end="2026-11-15"
           reference_number="2026/41831"
           date_modified="2026-10-27 07:53:44">
    <Versions>
      <Version language="nb">
        <Title>Ledig stilling som branninspektør</Title>
        <TitleHeading>Vil du jobbe med forebyggende brannvern i Indre Fosen?</TitleHeading>
        <AlternativeCompanyName>Trøndelag brann- og redningstjeneste IKS Forebyggende avdeling</AlternativeCompanyName>
        <ApplicationDeadline>15.11.2026</ApplicationDeadline>
        <Location>Rissa</Location>
        <Region>
          <Country id="160" name="Norge"><County id="9">Trøndelag</County></Country>
        </Region>
        <Categories>
          <Item type="position-type" id="51039">Heltid</Item>
          <Item type="duration" id="permanent">Fast</Item>
          <Item type="extent" id="fulltime">Heltid</Item>
          <Item type="operating-time" id="day">Dag</Item>
        </Categories>
      </Version>
    </Versions>
    <Departments>
      <Department id="154055">
        <Name>Forebyggende avdeling</Name>
        <VacancyURL>https://<slug>.easycruit.com/vacancy/3672463/154055</VacancyURL>
        <ApplicationURL>https://<slug>.easycruit.com/vacancy/application/3672463/154055</ApplicationURL>
      </Department>
    </Departments>
  </Vacancy>
</VacancyList>
```

| Field | Use |
|---|---|
| `Vacancy@id` | Unique vacancy id (`3672463`). |
| `Vacancy@date_start` | Posting start date (`YYYY-MM-DD`) — the CLI's `date`. |
| `Vacancy@date_end` | Deadline date (`YYYY-MM-DD`). |
| `Version/Title` | Vacancy title. |
| `Version/TitleHeading` | Short intro/deck. |
| `Version/Location` | Workplace or municipality text. Often a department (`Ved våre barnehager`) rather than a city. |
| `Version/Region/Country/County` | Region fallback (`Trøndelag`, `Norge`). |
| `Version/Categories/Item` | Employment type (`Fast`, `Engasjement`, `Heltid`, `Dag`, …). |
| `Department/VacancyURL` | Canonical public vacancy URL, including the department id. |

The joblist does **not** include `<Description>`.

### 3. XML vacancy detail — date and full description

```
GET https://<slug>.easycruit.com/export/xml/vacancy/<id>.xml
```

HTTP 200. Same `Vacancy`/`Version` structure as the joblist, plus:

```xml
<Vacancy id="3673377" date_start="2026-11-05" date_end="2026-12-01" reference_number="">
  <Versions>
    <Version language="nb">
      <Title>…</Title>
      <Location>Skatval legekontor</Location>
      <ApplicationDeadline>01.12.2026</ApplicationDeadline>
      <Description>&lt;p&gt;…full HTML, escaped…&lt;/p&gt;</Description>
      …
    </Version>
  </Versions>
</Vacancy>
```

The CLI uses `date_start` for `date` and falls back to
`<Description>` if the HTML detail is unavailable.

### 4. Public HTML detail — workplace and readable description

```
GET https://<slug>.easycruit.com/vacancy/<id>/rss
```

HTTP 200. Despite the `/rss` suffix this is the full HTML vacancy page (not an
RSS document). Relevant anchors:

| Selector | Content |
|---|---|
| `<h1>` | Vacancy title |
| `div.jd-description` | Full description HTML |
| `div.jd-location` | `<h3>Arbeidssted:</h3><p>Skatval legekontor</p>` |
| `div.jd-deadline` | `<h3>Søknadsfrist:</h3><p>01.12.2026</p>` |
| `div.jd-worktime` | `<h3>Arbeidstid:</h3><p>Dag</p>` |
| `div.jd-engagement` | `<h3>Tiltredelse:</h3><p>Snarest</p>` |
| `meta[property="og:url"]` | `http(s)://<slug>.easycruit.com/vacancy/<id>/rss?iso=no` |

The plain `GET /vacancy/<id>` may return the AWS WAF challenge (HTTP 202). Use
the `/rss` variant for a stable 200.

## Registry `ats_ref` forms

Rows with `ats=easycruit` in `job_scraper/employers.csv`:

| Employer | `ats_ref` | Live result |
|---|---|---|
| STJØRDAL KOMMUNE | `https://stjordal.easycruit.com` | 13 vacancies on 6 Nov 2026. |
| TRØNDELAG BRANN- OG REDNINGSTJENESTE IKS | `https://tbrt.easycruit.com` | 4 vacancies on 6 Nov 2026. |
| STIFTELSEN HANDELSHØYSKOLEN BI | `https://bi.easycruit.com` | 14 vacancies on 6 Nov 2026. |

The merged registry is the single source of truth for these URLs. An enabled
`ats=easycruit` row with a missing or invalid `ats_ref` is skipped and reported
in `meta.errors`; the CLI never guesses or silently repairs a ref. Rows with a
different `ats` are another portal's business and are skipped.

## Access and terms

- **robots.txt:** `Allow: /` except `Disallow: /intranet/` on all three sites.
- **Authentication:** none for the feeds and detail paths above.
- **WAF:** AWS WAF JavaScript challenge (HTTP 202) on the root and HTML search
  pages, and sometimes on plain `/vacancy/<id>`. Not bypassed.
- **Rate limits:** 429/5xx are retried with exponential backoff and jitter
  (max 6). The CLI caps employer concurrency at 4 and detail fetches at
  `--detail-limit` (default 40) per run.
- **Volume:** public RSS/XML read at low volume for personal job search.
- **Verification date:** 6 Nov 2026.
