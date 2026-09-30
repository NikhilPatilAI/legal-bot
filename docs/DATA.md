# Data

## Bundled with the repository

| Path                                             | What                                                                                                         | Source                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/sample-pdfs/`                              | 4 official Acts: LLP Act 2008, Trade Marks Act 1999, FEMA 1999, CGST Act 2017 (as amended to 1 January 2022) | India Code, IP India, CBIC; URLs in `manifest.json`                                                                                                                                                                                             |
| `data/sections/companies-act-2013.sections.json` | The Companies Act, 2013 parsed into sections, sub-sections and cross-references                              | Official reproduction published by the Technology Development Board, [tdb.gov.in](https://www.tdb.gov.in/sites/default/files/2024-05/companiesact2013.pdf) (downloaded 2026-09-01); see [`data/sections/SOURCE.md`](../data/sections/SOURCE.md) |
| `data/history/companies-act-2013.history.json`   | Dated versions of Companies Act section 135(5)–(6), each with the Gazette source proving its commencement    | Act 22 of 2019 and S.O. 324(E) (eGazette)                                                                                                                                                                                                       |
| `data/eval/`                                     | Evaluation sets                                                                                              | See [EVALUATION.md](EVALUATION.md)                                                                                                                                                                                                              |

Indian Acts are reproduced here under section 52(1)(q) of the Copyright Act, 1957, which permits reproduction of Acts of the legislature. Rules, regulations and circulars you add yourself may carry other terms; check before redistributing them.

Every indexed text has `legalStatus: unknown`: it is an official publication, but not verified as the current consolidated law.

## The full corpus (not distributed)

The project was developed against a private collection of **5,082 official PDFs** across Companies, LLP, SEBI, GST, trade marks, IBBI/insolvency, RBI/FEMA, income tax and selected case law, downloaded from Government of India sources. Its index is 723 MB and is not part of this repository. The evaluation sets reference its documents by content-addressed id (`legal_` + the first 24 hex characters of the PDF's SHA-256), so anyone who ingests the same official PDFs gets the same ids.

## Adding your own PDFs

1. Put the PDFs in a folder.
2. Create `manifest.json` in that folder:

```json
{
  "schemaVersion": "legal-bot-manifest-v1",
  "documents": [
    {
      "file": "gst/cgst-rules-2017.pdf",
      "title": "Central Goods and Services Tax Rules, 2017",
      "authority": "Central Board of Indirect Taxes and Customs",
      "legalCategory": "gst",
      "documentType": "rules",
      "amendmentDate": "2024-01-01",
      "finalPdfUrl": "https://cbic-gst.gov.in/pdf/....pdf",
      "officialLandingUrl": "https://cbic-gst.gov.in/...."
    }
  ]
}
```

| Field                                                                                                      | Required     | Notes                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `file`                                                                                                     | yes          | Path relative to the manifest; may not leave the folder                                                               |
| `title`, `authority`                                                                                       | yes          | Shown in citations. Include "as amended up to DD.MM.YYYY" in the title for consolidations, so the newest version wins |
| `legalCategory`                                                                                            | yes          | `companies`, `llp`, `sebi`, `gst`, `trademarks`, `ibbi`, `rbi-fema`, `income-tax`, `case-law`                         |
| `finalPdfUrl` / `officialLandingUrl`                                                                       | at least one | Must be HTTPS on the official-host allow-list (`src/rag/ingestion/manifest.ts`) unless `--allow-unofficial`           |
| `documentType`, `documentNumber`, `publicationDate`, `effectiveDate`, `amendmentDate`, `language`, `notes` | no           | Dates as `YYYY-MM-DD`                                                                                                 |

3. Build or update the index:

```bash
pnpm ingest -- --manifest path/to/manifest.json --index data/index/legal-bot.sqlite
```

Re-running is incremental. Failures (unreadable PDFs, missing files, unofficial sources) are listed in `reports/ingest-report.json` and do not stop the run. Scanned PDFs without a text layer are indexed as `ocr_required` metadata-only entries; run OCR first to make their content searchable.
