# CIViC Clinical Report Inputs

Place these assets in this folder:

- `vcf_report_generator.py`
- `civic_chroma_db/` (entire folder)

Then set this in `backend/.env`:

```env
CIVIC_REPORT_DIR=D:\automated_ngs\backend\tools\civic_report
```

The frontend "Downstream Analysis (CIViC Report)" page will call:

```bash
python vcf_report_generator.py <input.vcf> --output <clinical_report.html>
```

The API also exports `CIVIC_CHROMA_DB_DIR` to the Python process.
