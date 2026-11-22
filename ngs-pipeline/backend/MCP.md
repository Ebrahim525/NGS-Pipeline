# NGS pipeline MCP server

From the backend directory, install dependencies with `npm ci`. Configure an MCP client to launch the server over stdio using the absolute path to `mcp-server.js`.

```json
{
  "mcpServers": {
    "ngs-pipeline": {
      "command": "node",
      "args": ["/absolute/path/to/ngs-pipeline/backend/mcp-server.js"],
      "env": {
        "NGS_RESULTS_ROOT": "/absolute/path/to/ngs_data"
      }
    }
  }
}
```

The root can contain VCFs directly or results at `<patient>/variant_annotation/annotated_variants.vcf[.gz]`. When `NGS_RESULTS_ROOT` is absent, the server looks for the data folder saved by the existing app. For a local demo, point the root at `ngs-pipeline/backend/uploads` to use its bundled VEP output.

| Tool | Purpose |
|---|---|
| `list_patients` | Find the existing patient folders under the data root |
| `create_patient` | Create a patient folder in the same data root as the frontend |
| `list_results` | Find available VCFs and their sample names, optionally within one patient folder |
| `list_variants` | Page through called alternate alleles, optionally by gene or annotation status |
| `list_genes` | Count called alternate alleles annotated to each gene |
| `get_variant` | Look up one call, its transcript consequences, and its allele fraction fields |
| `get_clinical_evidence` | Find accepted, exact-variant CIViC evidence for a supplied disease |

Carry the returned `resultId` and `sample` across follow-up questions. After listing variants, pass the chosen `variantId` to `get_variant`. A multiallelic VCF row can return a different variant ID for each called ALT allele. Defaults include PASS and unfiltered calls. The output labels each filter status and keeps sample read fraction from `FORMAT/AD`, sample `FORMAT/AF`, and site `INFO/AF` separate.

The evidence tool accepts an exact CIViC disease name or a Disease Ontology ID such as `DOID:3908`. It downloads the public CIViC release and matches locally using exact genomic alleles or versioned coding HGVS. Sample data stays local. To use local copies of the release, set `NGS_CIVIC_DIR` to a directory containing `nightly-VariantSummaries.tsv` and `nightly-ClinicalEvidenceSummaries.tsv`. Evidence results include the CIViC item, direction, level, citation, and source VCF record. [CIViC data releases](https://civic.readthedocs.io/en/latest/using/data_releases.html)

## Run one stage from chat

Run the existing Express backend with `npm start` from this directory and configure the sequencing programs using `.env.example`. Both the backend and the MCP server use the saved data folder by default. When setting `NGS_RESULTS_ROOT` explicitly, set it to the same directory for both processes. The MCP server uses backend port `8787` by default. Set `NGS_PIPELINE_PORT` in the MCP client if the backend uses a different `PORT`.

1. Use `list_patients` to find an existing patient, or ask the chatbot to create one with `create_patient`. Use the exact returned folder name. Spaces become underscores, as in the frontend.
2. Pass that name as `patient` to `list_stage_inputs` and select the input artifacts. Patient inputs come from the selected folder. Shared references can come from the data root or the backend’s `NGS_REFERENCE_FASTA` setting.
3. Use the same `patient` in `plan_stage_run` to preview the parameters and patient output paths. `start_stage_run` returns the run ID, and `get_run_status` returns the final artifacts or an error.

For example, ask “Run VEP for Patient1 on their called VCF with eight forks.” The annotated VCF is published as `Patient1/variant_annotation/annotated_variants.vcf` when that filename is available. A rerun with a conflicting filename is published under `Patient1/variant_annotation/runs/<run-id>/`. The same rule applies to `quality_control`, `trimming`, `alignment`, `post_alignment`, `variant_calling`, and `ngs-report`. `list_results` can find both the default annotation and versioned MCP results.

Stages include `fastqc`, `bbduk`, `alignment`, `mark-duplicates`, `read-groups`, `haplotype-caller`, `vep`, and the legacy `civic-report`. The legacy report requires the Ion Reporter format. For VEP results, use the CIViC evidence query tool.

`prepare-reference` publishes the FASTA and indexes in the patient’s `reference` folder. `index-bam` publishes the index beside that patient’s BAM when the index filename is free. When an index already exists, it publishes the BAM and its new index together in a version folder. The run metadata and original run artifacts are kept in `.stage-runs`.
