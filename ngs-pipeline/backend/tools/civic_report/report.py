#!/usr/bin/env python3
"""
VCF Annotated Report Generator v3
Parses an annotated VCF (Oncomine / Ion Reporter format) and produces an HTML
clinical-style genomics report using live open-source databases:
  - CIViC (civicdb.org) via GraphQL API
  - ClinicalTrials.gov v2 API
  - MyVariant.info API

Usage:
    python vcf_report_generator.py <input.vcf> [--output report.html]
                                               [--af-threshold 0.005]
                                               [--no-cache]
"""

import sys, re, ast, json, argparse, html, time, hashlib
from pathlib import Path
from datetime import datetime

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False
    print("WARNING: 'requests' not installed — API lookups disabled. pip install requests", file=sys.stderr)


# ── VCF Parsing ────────────────────────────────────────────────────────────────

def parse_info(info_str):
    result = {}
    for part in info_str.split(";"):
        if "=" in part:
            k, _, v = part.partition("=")
            result[k.strip()] = v.strip()
        else:
            result[part.strip()] = True
    return result


def parse_func(func_str):
    if not func_str or func_str == ".":
        return {}
    try:
        parsed = ast.literal_eval(func_str)
        if isinstance(parsed, list) and parsed:
            return parsed[0]
    except Exception:
        pass
    m = re.search(r"'gene'\s*:\s*'([^']+)'", func_str)
    gene = m.group(1) if m else ""
    m2 = re.search(r"'protein'\s*:\s*'([^']+)'", func_str)
    protein = m2.group(1) if m2 else ""
    m3 = re.search(r"'coding'\s*:\s*'([^']+)'", func_str)
    coding = m3.group(1) if m3 else ""
    return {"gene": gene, "protein": protein, "coding": coding}


def parse_vcf(vcf_path, af_threshold=0.005):
    metadata, snv_variants, cnv_variants, fusion_calls, all_pass_low = {}, [], [], [], []
    sample_name = "Unknown"
    meta_re = re.compile(r"^##([^=<]+)=(.+)$")

    with open(vcf_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("##"):
                m = meta_re.match(line)
                if m:
                    key, val = m.group(1).strip(), m.group(2).strip().strip('"')
                    if not val.startswith("<"):
                        metadata[key] = val
                continue
            if line.startswith("#CHROM"):
                cols = line.lstrip("#").split("\t")
                if len(cols) > 9:
                    sample_name = cols[-1]
                continue
            parts = line.split("\t")
            if len(parts) < 8:
                continue
            chrom, pos, vid, ref, alt, qual, filt, info_raw = parts[:8]
            info = parse_info(info_raw)
            svtype = info.get("SVTYPE", "")
            func = parse_func(info.get("FUNC", ""))
            gene = func.get("gene", info.get("GENE_NAME", ""))
            protein = func.get("protein", "")
            coding = func.get("coding", "")
            try:
                af = float(info.get("AF", 0))
            except (ValueError, TypeError):
                af = 0.0
            try:
                dp = int(info.get("DP", info.get("FDP", 0)))
            except (ValueError, TypeError):
                dp = 0
            try:
                ao = int(info.get("FAO", info.get("AO", 0)))
            except (ValueError, TypeError):
                ao = 0

            if svtype == "CNV" and filt in ("PASS", "GAIN", "LOSS"):
                try:
                    raw_cn = float(info.get("RAW_CN", 2))
                except (ValueError, TypeError):
                    raw_cn = 2.0
                try:
                    ref_cn = float(info.get("REF_CN", 2))
                except (ValueError, TypeError):
                    ref_cn = 2.0
                cn_call = ("Amplification" if raw_cn > ref_cn * 1.5
                           else "Loss" if raw_cn < ref_cn * 0.7 else "Neutral")
                cnv_variants.append({"gene": gene, "chrom": chrom, "pos": pos,
                    "raw_cn": round(raw_cn, 2), "ref_cn": ref_cn, "cn_call": cn_call,
                    "filter": filt, "end": info.get("END", ""), "num_tiles": info.get("NUMTILES", "")})
                continue

            if svtype in ("Fusion", "RNAExonVariant", "RNAExonTiles", "GeneExpression",
                          "ExprControl", "ProcControl", "5p3pAssays"):
                if filt == "PASS":
                    fusion_calls.append({"id": vid, "gene": gene, "chrom": chrom, "pos": pos,
                        "svtype": svtype, "pass_reason": info.get("PASS_REASON", "")})
                continue

            if filt == "PASS" and gene:
                var = {"gene": gene, "chrom": chrom, "pos": pos, "ref": ref, "alt": alt,
                    "af": af, "af_pct": f"{af*100:.2f}%", "dp": dp, "ao": ao, "qual": qual,
                    "protein": protein, "coding": coding,
                    "function": func.get("function", ""), "exon": func.get("exon", ""),
                    "transcript": func.get("transcript", ""),
                    "clnsig": func.get("CLNSIG1", func.get("CLNSIG", "")),
                    "cosmic_id": vid if vid.startswith("COSM") else "",
                    "filter": filt, "hs": "HS" in info}
                (snv_variants if af >= af_threshold else all_pass_low).append(var)

    def dedup(variants):
        seen = {}
        for v in variants:
            key = (v["gene"], v["protein"] or v["coding"] or v["pos"])
            if key not in seen or v["af"] > seen[key]["af"]:
                seen[key] = v
        return sorted(seen.values(), key=lambda x: x["af"], reverse=True)

    seen_cnv = {}
    for v in cnv_variants:
        g = v["gene"]
        if g not in seen_cnv or v["cn_call"] != "Neutral":
            seen_cnv[g] = v

    return {
        "metadata": metadata,
        "snv_variants": dedup(snv_variants),
        "cnv_variants": sorted(seen_cnv.values(), key=lambda x: x["gene"]),
        "fusion_calls": fusion_calls,
        "low_af_variants": [v for v in dedup(all_pass_low) if v["af"] > 0],
        "sample_name": sample_name,
    }


# ── Protein Normalization ───────────────────────────────────────────────────────

def normalize_protein(protein):
    p = protein.strip()
    p = re.sub(r"^p\.", "", p)
    p = re.sub(r"^\((.+)\)$", r"\1", p)
    return p


# ── API Cache ──────────────────────────────────────────────────────────────────

CACHE_TTL_DAYS = 7

def load_cache(cache_path):
    if cache_path and Path(cache_path).exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_cache(cache, cache_path):
    if not cache_path:
        return
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except Exception as e:
        print(f"WARNING: Could not save cache: {e}", file=sys.stderr)

def cache_get(cache, key):
    entry = cache.get(key)
    if not entry:
        return None
    if time.time() - entry.get("ts", 0) > CACHE_TTL_DAYS * 86400:
        return None
    return entry.get("data")

def cache_set(cache, key, data):
    cache[key] = {"ts": time.time(), "data": data}


# ── Disease Matching ────────────────────────────────────────────────────────────

_NOISE = {"cancer","type","and","the","of","in","not","or","with","tumor",
          "tumour","unknown","primary","nos","advanced","metastatic"}

def disease_keywords(s):
    if not s:
        return set()
    words = re.findall(r"[a-z]+", s.lower())
    return {w for w in words if len(w) > 2 and w not in _NOISE}

def disease_matches(sample_disease, civic_disease):
    if not civic_disease:
        return False
    sk = disease_keywords(sample_disease)
    ck = disease_keywords(civic_disease)
    return bool(sk and ck and (sk & ck))


# ── CIViC GraphQL Client ────────────────────────────────────────────────────────

CIVIC_URL = "https://civicdb.org/api/graphql"

LEVEL_ORDER = ["A", "B", "C", "D", "E"]
CIVIC_LEVEL_TO_TIER = {"A": "IA", "B": "IB", "C": "IIC", "D": "IID", "E": "III"}
TIER_COLORS = {"IA": "#1a6e2b", "IB": "#2e8b57", "IIC": "#c07000",
               "IID": "#c07000", "III": "#7f8c8d", "IV": "#95a5a6"}

_CIVIC_LOOKUP_Q = """
{
  geneInfo: gene(entrezSymbol: %s) { id name description }
  variantSearch: browseVariants(featureName: %s, variantName: %s, first: 3) {
    nodes { id name }
  }
}
"""

_CIVIC_EVIDENCE_Q = """
{
  evidenceItems(variantId: %d, status: ACCEPTED, first: 100) {
    totalCount
    nodes {
      id evidenceLevel evidenceType significance evidenceDirection description
      therapies { name }
      disease { name }
      source { citation }
    }
  }
  variant(id: %d) {
    singleVariantMolecularProfile { description }
  }
}
"""


def _civic_post(query, cache, cache_path, no_cache):
    if not REQUESTS_AVAILABLE:
        return None
    ck = "civic:" + hashlib.md5(query.encode()).hexdigest()
    if not no_cache:
        cached = cache_get(cache, ck)
        if cached is not None:
            return cached
    try:
        r = requests.post(CIVIC_URL, json={"query": query},
                          headers={"Content-Type": "application/json"}, timeout=30)
        print("rrrrrrrrrrrrrrrrrrrrrrrrrrrrr")
        print(r)
        if r.status_code == 200:
            data = r.json()
            if "errors" not in data:
                cache_set(cache, ck, data)
                save_cache(cache, cache_path)
                return data
            # Log first error
            print(f"WARNING: CIViC error: {data['errors'][0]['message']}", file=sys.stderr)
        else:
            print(r.status_code)

    except Exception as e:
        print(f"WARNING: CIViC request error: {e}", file=sys.stderr)
    return None


def _protein_search_terms(protein_core):
    terms = [protein_core]
    # Strip trailing amino acid / stop codon to get position prefix, e.g. K601N→K601, Q167*→Q167
    prefix = re.sub(r"[A-Za-z*fs]+$", "", protein_core)
    if prefix and prefix != protein_core and len(prefix) >= 2:
        terms.append(prefix)
    return terms


# ── CIViC Vector DB (semantic fallback) ───────────────────────────────────────

_CIVIC_DB_DIRNAME = "civic_chroma_db"
_EMBED_MODEL = "all-MiniLM-L6-v2"


def load_civic_vectordb(db_path=None):
    """Load ChromaDB collection if available. Returns collection or None."""
    path = Path(db_path) if db_path else Path(__file__).parent / _CIVIC_DB_DIRNAME
    if not path.exists():
        return None
    try:
        import chromadb
        from chromadb.utils.embedding_functions import (
            SentenceTransformerEmbeddingFunction,
        )
        ef = SentenceTransformerEmbeddingFunction(model_name=_EMBED_MODEL)
        client = chromadb.PersistentClient(path=str(path))
        coll = client.get_collection("civic_variants", embedding_function=ef)
        return coll
    except Exception as e:
        print(f"WARNING: Could not load CIViC vector DB: {e}", file=sys.stderr)
        return None


def _query_civic_vectordb(gene, protein_core, civic_db):
    """Semantic search: returns (variant_id, variant_name) or (None, None)."""
    try:
        results = civic_db.query(
            query_texts=[f"{gene} {protein_core}"],
            n_results=3,
            where={"gene": gene},
        )
        metas = results.get("metadatas", [[]])[0]
        if metas:
            best = metas[0]
            return best["variant_id"], best["variant_name"]
    except Exception as e:
        print(f"WARNING: Vector DB query error: {e}", file=sys.stderr)
    return None, None


def fetch_civic_data(gene, protein_core, cache, cache_path, no_cache, civic_db=None):
    """
    Returns (gene_description, variant_description, evidence_items_list).
    Priority: exact API match → position-prefix API match → semantic vector DB match.
    """
    gene_q = json.dumps(gene)

    gene_desc = ""
    for search_term in _protein_search_terms(protein_core):
        protein_q = json.dumps(search_term)
        lookup = _civic_post(_CIVIC_LOOKUP_Q % (gene_q, gene_q, protein_q),
                             cache, cache_path, no_cache)
        if not lookup or "data" not in lookup:
            print('lookup or "data" not in lookup')
            continue

        gene_data = lookup["data"].get("geneInfo") or {}
        gene_desc = gene_data.get("description", "") or gene_desc

        variant_nodes = lookup["data"].get("variantSearch", {}).get("nodes", [])
        if not variant_nodes:
            continue

        variant_id = variant_nodes[0]["id"]
        matched_name = variant_nodes[0]["name"]
        is_exact = matched_name.upper() == protein_core.upper()

        ev_result = _civic_post(_CIVIC_EVIDENCE_Q % (variant_id, variant_id),
                                cache, cache_path, no_cache)
        if not ev_result or "data" not in ev_result:
            continue

        ev_nodes = ev_result["data"].get("evidenceItems", {}).get("nodes", [])
        var_node = ev_result["data"].get("variant", {}) or {}
        mp_desc = ((var_node.get("singleVariantMolecularProfile") or {})
                   .get("description", ""))
        if not is_exact:
            note = f"[Closest CIViC match: {matched_name}]"
            mp_desc = (note + " " + (mp_desc or "")).strip()

        return gene_desc, mp_desc, ev_nodes

    # ── Semantic fallback via local vector DB ─────────────────────────────
    if civic_db is not None:
        vdb_id, vdb_name = _query_civic_vectordb(gene, protein_core, civic_db)
        if vdb_id is not None:
            ev_result = _civic_post(_CIVIC_EVIDENCE_Q % (vdb_id, vdb_id),
                                    cache, cache_path, no_cache)
            if ev_result and "data" in ev_result:
                ev_nodes = ev_result["data"].get("evidenceItems", {}).get("nodes", [])
                var_node = ev_result["data"].get("variant", {}) or {}
                mp_desc = ((var_node.get("singleVariantMolecularProfile") or {})
                           .get("description", ""))
                note = f"[Semantic CIViC match: {vdb_name}]"
                mp_desc = (note + " " + (mp_desc or "")).strip()
                return gene_desc, mp_desc, ev_nodes

    return gene_desc, "", []


# ── ClinicalTrials.gov v2 Client ───────────────────────────────────────────────

CTGOV_API = "https://clinicaltrials.gov/api/v2/studies"

def fetch_clinical_trials(gene, protein_core, cache, cache_path, no_cache):
    if not REQUESTS_AVAILABLE:
        return []
    ck = f"ctgov:{gene}:{protein_core}"
    if not no_cache:
        cached = cache_get(cache, ck)
        if cached is not None:
            return cached
    params = {
        "query.term": f"{gene} {protein_core}",
        "pageSize": 50,
        "format": "json",
    }
    try:
        r = requests.get(CTGOV_API, params=params, timeout=30)
        if r.status_code == 200:
            studies = r.json().get("studies", [])
            trials = []
            for s in studies:
                ps = s.get("protocolSection", {})
                id_mod = ps.get("identificationModule", {})
                status_mod = ps.get("statusModule", {})
                design_mod = ps.get("designModule", {})
                phases = design_mod.get("phases", [])
                phase_str = "/".join(p.replace("PHASE", "").strip()
                                     for p in phases if "PHASE" in p) or "N/A"
                nct = id_mod.get("nctId", "")
                if nct:
                    trials.append({
                        "nct_id": nct,
                        "title": id_mod.get("briefTitle", id_mod.get("officialTitle", "")),
                        "phase": f"Phase {phase_str}" if phase_str != "N/A" else "N/A",
                        "status": status_mod.get("overallStatus", ""),
                    })
            cache_set(cache, ck, trials)
            save_cache(cache, cache_path)
            return trials
    except Exception as e:
        print(f"WARNING: ClinicalTrials.gov error for {gene} {protein_core}: {e}", file=sys.stderr)
    return []


# ── MyVariant.info Client ──────────────────────────────────────────────────────

def fetch_myvariant(gene, protein_core, cache, cache_path, no_cache):
    if not REQUESTS_AVAILABLE:
        return {}
    ck = f"myvariant:{gene}:{protein_core}"
    if not no_cache:
        cached = cache_get(cache, ck)
        if cached is not None:
            return cached
    try:
        r = requests.get("https://myvariant.info/v1/query",
                         params={"q": f"{gene}:p.{protein_core}", "size": 1,
                                 "fields": "clinvar,cosmic,dbnsfp"},
                         timeout=20)
        if r.status_code == 200:
            hits = r.json().get("hits", [])
            result = hits[0] if hits else {}
            cache_set(cache, ck, result)
            save_cache(cache, cache_path)
            return result
    except Exception as e:
        print(f"WARNING: MyVariant.info error for {gene} p.{protein_core}: {e}", file=sys.stderr)
    return {}


# ── Variant Enrichment ─────────────────────────────────────────────────────────

def enrich_variant(var, disease_type, cache, cache_path, no_cache, civic_db=None):
    gene = var["gene"]
    protein = var.get("protein", "")
    protein_core = normalize_protein(protein) if protein else ""

    result = {
        "tier": "IV", "tier_color": TIER_COLORS["IV"],
        "therapies_this": [], "therapies_other": [],
        "clinical_trials": [],
        "gene_description": "", "variant_description": "",
        "clinsig": var.get("clnsig", ""),
        "predictive": [], "prognostic": [], "diagnostic": [],
    }

    # ── CIViC ──
    if protein_core:
        gene_desc, var_desc, evidence_items = fetch_civic_data(
            gene, protein_core, cache, cache_path, no_cache, civic_db)
        result["gene_description"] = gene_desc
        result["variant_description"] = var_desc

        if evidence_items:
            # Best tier from highest evidence level
            best = None
            for item in evidence_items:
                lvl = item.get("evidenceLevel", "E")
                if best is None or LEVEL_ORDER.index(lvl) < LEVEL_ORDER.index(best):
                    best = lvl
            if best:
                result["tier"] = CIVIC_LEVEL_TO_TIER.get(best, "IV")
                result["tier_color"] = TIER_COLORS.get(result["tier"], "#95a5a6")

            # Categorise evidence
            for item in evidence_items:
                etype = item.get("evidenceType", "")
                if etype == "PREDICTIVE":
                    result["predictive"].append(item)
                elif etype == "PROGNOSTIC":
                    result["prognostic"].append(item)
                elif etype == "DIAGNOSTIC":
                    result["diagnostic"].append(item)

            # Build therapy lists — deduplicate by drug, keep highest level
            seen_drugs = {}
            for item in evidence_items:
                if item.get("evidenceType") != "PREDICTIVE":
                    continue
                lvl = item.get("evidenceLevel", "E")
                for t in item.get("therapies", []):
                    drug = t.get("name", "")
                    if not drug:
                        continue
                    if drug not in seen_drugs:
                        seen_drugs[drug] = item
                    else:
                        curr = seen_drugs[drug].get("evidenceLevel", "E")
                        if LEVEL_ORDER.index(lvl) < LEVEL_ORDER.index(curr):
                            seen_drugs[drug] = item

            for drug, item in seen_drugs.items():
                disease_name = (item.get("disease") or {}).get("name", "")
                entry = {
                    "drug": drug,
                    "level": item.get("evidenceLevel", ""),
                    "direction": item.get("evidenceDirection", ""),
                    "significance": item.get("significance", ""),
                    "disease": disease_name,
                    "description": item.get("description", ""),
                    "citation": (item.get("source") or {}).get("citation", ""),
                }
                if disease_matches(disease_type, disease_name):
                    result["therapies_this"].append(entry)
                else:
                    result["therapies_other"].append(entry)

            for key in ("therapies_this", "therapies_other"):
                result[key].sort(key=lambda x: LEVEL_ORDER.index(x["level"])
                                 if x["level"] in LEVEL_ORDER else 99)

    # Fallback tier from VCF CLNSIG
    if result["tier"] == "IV":
        clnsig = var.get("clnsig", "").lower()
        if "pathogenic" in clnsig or "drug response" in clnsig:
            result["tier"] = "IIC"
            result["tier_color"] = TIER_COLORS["IIC"]

    # ── ClinicalTrials.gov ──
    if protein_core:
        result["clinical_trials"] = fetch_clinical_trials(
            gene, protein_core, cache, cache_path, no_cache)

    # ── MyVariant.info ──
    if protein_core:
        mv = fetch_myvariant(gene, protein_core, cache, cache_path, no_cache)
        clinvar = mv.get("clinvar", {})
        if isinstance(clinvar, dict):
            sig = clinvar.get("clinical_significance", "")
            if sig:
                result["clinsig"] = sig
        elif not result["clinsig"]:
            dbnsfp = mv.get("dbnsfp", {})
            if isinstance(dbnsfp, dict):
                pred = dbnsfp.get("clinpred_pred", "")
                if pred:
                    result["clinsig"] = f"ClinPred: {pred}"

    return result


def enrich_all(key_variants, disease_type, cache, cache_path, no_cache, civic_db=None):
    enriched = {}
    for v in key_variants:
        key = (v["gene"], v.get("protein", ""))
        print(f"  Querying APIs: {v['gene']} {v.get('protein','')}", file=sys.stderr)
        enriched[key] = enrich_variant(v, disease_type, cache, cache_path, no_cache, civic_db)
    return enriched

def get_enc(enriched, var):
    return enriched.get((var["gene"], var.get("protein", "")), {})




# ── HTML Helpers ───────────────────────────────────────────────────────────────

def h(s):
    return html.escape(str(s)) if s else ""

def badge(text, bg, fg="white"):
    return (f'<span style="background:{bg};color:{fg};padding:2px 8px;border-radius:4px;'
            f'font-size:0.82em;font-weight:600;white-space:nowrap;">{h(text)}</span>')

def source_dot(active):
    return ('<span style="color:#27ae60;font-size:1.1em;">&#10003;</span>' if active
            else '<span style="color:#ccc;font-size:1.1em;">&#8722;</span>')

def cn_badge(call):
    colors = {"Amplification": "#e74c3c", "Loss": "#3498db", "Neutral": "#27ae60"}
    return badge(call, colors.get(call, "#95a5a6"))

def alert_icon(atype):
    icons = {"Breakthrough": ("&#9733;", "#8e44ad"), "Fast Track": ("&#9654;", "#2980b9"),
             "Contraindicated": ("&#9888;", "#e74c3c"), "Resistance": ("&#128683;", "#c0392b")}
    sym, col = icons.get(atype, ("&#9679;", "#7f8c8d"))
    return f'<span style="color:{col};font-size:1.1em;">{sym}</span>'

def af_bar(af):
    pct = af * 100
    width = min(int(pct * 2.5), 120)
    color = "#c0392b" if pct > 20 else "#e67e22" if pct > 5 else "#2980b9"
    return (f'<div style="display:flex;align-items:center;gap:6px;">'
            f'<div style="width:{width}px;height:8px;border-radius:4px;background:{color};min-width:2px;"></div>'
            f'<span style="white-space:nowrap;font-size:0.9em;">{pct:.2f}%</span></div>')

def section(title, body, id_=""):
    id_attr = f' id="{id_}"' if id_ else ""
    return f'\n<div class="section"{id_attr}>\n  <div class="section-title">{title}</div>\n  {body}\n</div>'

def lvl_badge(lvl):
    colors = {"A": "#1a6e2b", "B": "#2e8b57", "C": "#c07000", "D": "#c07000", "E": "#7f8c8d"}
    return badge(f"Level {lvl}", colors.get(lvl, "#95a5a6"))


# ── Section Builders ───────────────────────────────────────────────────────────

def build_patient_qc(meta, sample_name):
    def v(k): return h(meta.get(k, "N/A"))
    raw_date = meta.get("fileDate", "")
    try:
        file_date = datetime.strptime(raw_date, "%Y%m%d").strftime("%d %b %Y")
    except Exception:
        file_date = raw_date or "N/A"
    cell_raw = meta.get("manually_input_percent_tumor_cellularity",
                        meta.get("CellularityAsAFractionBetween0-1", "N/A"))
    try:
        cval = float(cell_raw)
        cellularity = f"{cval:.0f}%" if cval > 1 else f"{cval*100:.0f}%"
    except Exception:
        cellularity = str(cell_raw)
    total_reads_raw = meta.get("total_read_count", "")
    total_reads = f"{int(total_reads_raw):,}" if total_reads_raw.isdigit() else "N/A"
    try:
        median_reads = f"{float(meta.get('median_reads_per_amplicon','0')):,.0f}"
    except Exception:
        median_reads = "N/A"
    gender = meta.get("sampleGender", meta.get("AssumedGender", "N/A"))

    return f"""
<div class="qc-grid">
  <div class="qc-card"><div class="label">Total Reads</div><div class="value">{total_reads}</div></div>
  <div class="qc-card"><div class="label">Aligned Reads</div><div class="value">{v("percent_aligned_reads")}%</div></div>
  <div class="qc-card"><div class="label">Median Reads/Amplicon</div><div class="value">{median_reads}</div></div>
  <div class="qc-card"><div class="label">Non-Zero Amplicons</div><div class="value">{v("percent_non_zero_amplicons")}%</div></div>
  <div class="qc-card"><div class="label">MAPD</div><div class="value">{v("mapd")}</div></div>
  <div class="qc-card"><div class="label">Tumor Cellularity</div><div class="value">{h(cellularity)}</div></div>
  <div class="qc-card"><div class="label">Gender</div><div class="value">{h(gender)}</div></div>
  <div class="qc-card"><div class="label">File Date</div><div class="value">{h(file_date)}</div></div>
  <div class="qc-card"><div class="label">Reference</div><div class="value">{v("reference")}</div></div>
  <div class="qc-card"><div class="label">Disease Type</div><div class="value">{v("sampleDiseaseType")}</div></div>
</div>"""


def build_key_variants_table(snv_variants, enriched):
    if not snv_variants:
        return "<p class='empty'>No PASS variants detected above allele-frequency threshold.</p>"
    rows = []
    for v in snv_variants:
        enc = get_enc(enriched, v)
        tier = enc.get("tier", "IV")
        tier_color = enc.get("tier_color", TIER_COLORS["IV"])
        clnsig_disp = enc.get("clinsig") or v.get("clnsig", "")
        rows.append(f"""
      <tr>
        <td><strong>{h(v['gene'])}</strong></td>
        <td>{badge(tier, tier_color)}</td>
        <td class="mono">{h(v['protein']) or '&mdash;'}</td>
        <td>{h(v['exon']) or '&mdash;'}</td>
        <td class="mono">{h(v['coding']) or '&mdash;'}</td>
        <td>{af_bar(v['af'])}</td>
        <td>{h(v['function'].capitalize()) if v['function'] else '&mdash;'}</td>
        <td>{v['dp']:,}</td>
        <td style="font-size:0.85em;">{h(clnsig_disp) or '&mdash;'}</td>
      </tr>""")
    return f"""
<table>
  <thead><tr><th>Gene</th><th>Tier</th><th>Amino Acid Change</th><th>Exon</th>
    <th>Coding Change</th><th>Allele Frequency</th><th>Effect</th><th>Coverage</th><th>ClinVar</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>"""


def build_non_key_table(low_af_variants, threshold):
    if not low_af_variants:
        return "<p class='empty'>No additional PASS variants detected.</p>"
    rows = []
    for v in low_af_variants:
        rows.append(f"""
      <tr>
        <td><strong>{h(v['gene'])}</strong></td>
        <td class="mono">{h(v['protein']) or '&mdash;'}</td>
        <td class="mono">{h(v['coding']) or '&mdash;'}</td>
        <td>{v['af']*100:.3f}%</td>
        <td>{h(v['function'].capitalize()) if v['function'] else '&mdash;'}</td>
        <td style="font-size:0.85em;">{h(v.get('clnsig','')) or '&mdash;'}</td>
        <td>{v['dp']:,}</td>
      </tr>""")
    return f"""
<p class="note">Variants with 0.2% &le; AF &lt; {threshold*100:.1f}% with PASS filter.</p>
<table>
  <thead><tr><th>Gene</th><th>Amino Acid Change</th><th>Coding Change</th>
    <th>Allele Frequency</th><th>Effect</th><th>ClinVar</th><th>Coverage</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>"""


def build_clinical_relevance(key_variants, enriched):
    rows = []
    for v in key_variants:
        enc = get_enc(enriched, v)
        tier = enc.get("tier", "IV")
        tier_color = enc.get("tier_color", TIER_COLORS["IV"])
        therapies_this = enc.get("therapies_this", [])
        therapies_other = enc.get("therapies_other", [])
        n_trials = len(enc.get("clinical_trials", []))

        def therapy_list_html(therapies):
            if not therapies:
                return "<em style='color:#999;'>None found*</em>"
            return "<br>".join(
                f"{h(t['drug'])} {lvl_badge(t['level'])}"
                for t in therapies[:8]
            )

        rows.append(f"""
      <tr>
        <td style="white-space:nowrap;">{badge(tier, tier_color)}</td>
        <td>
          <strong>{h(v['gene'])} {h(v['protein'])}</strong>
          <span class="mono" style="font-size:0.85em;"> {h(v['coding'])}</span><br>
          <span class="note">AF: {v['af']*100:.2f}%</span>
        </td>
        <td>{therapy_list_html(therapies_this)}</td>
        <td>{therapy_list_html(therapies_other)}</td>
        <td style="text-align:center;font-weight:700;font-size:1.1em;">{n_trials}</td>
      </tr>""")

    if not rows:
        return "<p class='empty'>No clinical data found for key variants.</p>"
    return f"""
<p class="note">* Source: CIViC (civicdb.org) — Level A = FDA/guideline approved, B = clinical evidence, C = small studies, D = preclinical, E = inferential.</p>
<table>
  <thead><tr><th>Tier</th><th>Genomic Alteration</th>
    <th>Therapies (This Cancer Type)</th><th>Therapies (Other Cancer Types)</th>
    <th>Clinical Trials</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>
<p class="note" style="margin-top:8px;">Tier Reference: Li et al. J Mol Diagn. 2017;19(1):4-23.</p>"""


def build_therapy_summary(key_variants, enriched):
    blocks = []
    for v in key_variants:
        enc = get_enc(enriched, v)
        all_t = enc.get("therapies_this", []) + enc.get("therapies_other", [])
        if not all_t:
            continue
        variant_label = f"{h(v['gene'])} {h(v['protein'])} {h(v['coding'])}"
        rows = []
        for t in all_t[:20]:
            sig = t.get("significance", "").replace("_", " ").title()
            desc = t.get("description", "")
            desc_short = desc[:220] + ("…" if len(desc) > 220 else "")
            rows.append(f"""
        <tr>
          <td><strong>{h(t['drug'])}</strong></td>
          <td style="text-align:center;">{lvl_badge(t['level'])}</td>
          <td style="text-align:center;">{badge(sig, '#1e3a5f') if sig else '&mdash;'}</td>
          <td style="font-size:0.82em;color:#555;">{h(t['disease']) or '&mdash;'}</td>
          <td style="font-size:0.80em;color:#666;">{h(desc_short)}</td>
        </tr>""")
        blocks.append(f"""
<div class="variant-block">
  <div class="variant-block-title">{variant_label}</div>
  <table>
    <thead><tr><th>Drug / Therapy</th><th>Evidence Level</th><th>Significance</th>
      <th>Cancer Type</th><th>Evidence Summary</th></tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
  <p class="note" style="margin:6px 14px;">Source: CIViC database — accepted evidence items only.</p>
</div>""")

    if not blocks:
        return "<p class='empty'>No curated therapy data found in CIViC for key variants.</p>"
    return "\n".join(blocks)


def build_alerts(key_variants, enriched):
    alert_blocks = []
    for v in key_variants:
        enc = get_enc(enriched, v)
        variant_label = f"{h(v['gene'])} {h(v['protein'])} {h(v['coding'])}"
        entries = []

        # CIViC resistance signals
        for item in enc.get("predictive", []):
            sig = item.get("significance", "").upper()
            if sig in ("RESISTANCE", "ADVERSE_RESPONSE"):
                drugs = ", ".join(t["name"] for t in item.get("therapies", []) if t.get("name"))
                if not drugs:
                    continue
                disease_name = (item.get("disease") or {}).get("name", "")
                citation = (item.get("source") or {}).get("citation", "")
                entries.append(f"""
<div class="alert-entry">
  <div class="alert-header">{alert_icon("Resistance")} {badge("Resistance","#c0392b")}
    <strong style="margin-left:8px;">{h(drugs)}</strong> {lvl_badge(item.get('evidenceLevel',''))}
  </div>
  <div class="alert-meta">
    <span><strong>Cancer type:</strong> {h(disease_name)}</span>
    <span><strong>Significance:</strong> {h(sig.replace('_',' ').title())}</span>
  </div>
  <p class="alert-statement">{h(item.get('description',''))}</p>
  {('<p class="alert-ref"><strong>Source:</strong> ' + h(citation) + '</p>') if citation else ''}
</div>""")

        if entries:
            alert_blocks.append(f"""
<div class="variant-block">
  <div class="variant-block-title">{variant_label}</div>
  {''.join(entries)}
</div>""")

    if not alert_blocks:
        return "<p class='empty'>No resistance alerts found for key variants.</p>"
    legend = f"""
<div class="alert-legend">
  <span>{alert_icon('Contraindicated')} Contraindicated</span>
  <span>{alert_icon('Resistance')} Resistance</span>
  <span>{alert_icon('Breakthrough')} Breakthrough (FDA)</span>
  <span>{alert_icon('Fast Track')} Fast Track (FDA)</span>
</div>"""
    return legend + "\n".join(alert_blocks)


def build_clinical_trials(key_variants, enriched):
    blocks = []
    seen_nct = set()
    for v in key_variants:
        enc = get_enc(enriched, v)
        trials = enc.get("clinical_trials", [])
        if not trials:
            continue
        variant_label = f"{h(v['gene'])} {h(v['protein'])} {h(v['coding'])}"
        rows = []
        for t in trials[:50]:
            nct = t.get("nct_id", "")
            if nct in seen_nct:
                continue
            seen_nct.add(nct)
            nct_link = (f'<a href="https://clinicaltrials.gov/study/{h(nct)}" '
                        f'style="color:#2980b9;" target="_blank">{h(nct)}</a>'
                        if nct else "&mdash;")
            status = t.get("status", "")
            status_color = {"RECRUITING": "#1a6e2b", "ACTIVE_NOT_RECRUITING": "#c07000",
                           "NOT_YET_RECRUITING": "#2980b9"}.get(status, "#7f8c8d")
            rows.append(f"""
        <tr>
          <td style="white-space:nowrap;">{nct_link}</td>
          <td>{h(t.get('title',''))}</td>
          <td style="text-align:center;white-space:nowrap;">{h(t.get('phase',''))}</td>
          <td style="text-align:center;"><span style="color:{status_color};font-size:0.85em;">{h(status.replace('_',' ').title())}</span></td>
        </tr>""")
        if rows:
            blocks.append(f"""
<div class="variant-block">
  <div class="variant-block-title">{variant_label} &mdash; {len(trials)} trial(s)</div>
  <table>
    <thead><tr><th>NCT ID</th><th>Title</th><th>Phase</th><th>Status</th></tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
  <p class="note" style="margin:6px 14px;">Source: ClinicalTrials.gov v2 API.</p>
</div>""")

    if not blocks:
        return "<p class='empty'>No clinical trials found from ClinicalTrials.gov for key variants.</p>"
    return "\n".join(blocks)


# ── Disease → relevant gene panel mapping ─────────────────────────────────────

_DISEASE_GENE_PANELS = {
    "lung":              ["EGFR", "KRAS", "ALK", "ROS1", "BRAF", "MET", "RET",
                          "ERBB2", "NTRK1", "NTRK2", "NTRK3"],
    "breast":            ["ERBB2", "PIK3CA", "ESR1", "AKT1", "PTEN",
                          "FGFR1", "FGFR2"],
    "colorectal":        ["KRAS", "NRAS", "BRAF", "PIK3CA", "PTEN", "ERBB2", "MET"],
    "colon":             ["KRAS", "NRAS", "BRAF", "PIK3CA", "PTEN", "ERBB2", "MET"],
    "melanoma":          ["BRAF", "NRAS", "KIT", "GNAQ", "GNA11",
                          "MAP2K1", "MAP2K2"],
    "leukemia":          ["FLT3", "IDH1", "IDH2", "KRAS", "NRAS", "TP53", "KIT"],
    "thyroid":           ["BRAF", "RET", "NRAS", "KRAS", "HRAS",
                          "NTRK1", "NTRK2", "NTRK3"],
    "cholangiocarcinoma":["IDH1", "IDH2", "FGFR1", "FGFR2", "BRAF", "KRAS", "NRAS"],
    "gastric":           ["ERBB2", "FGFR2", "MET", "KRAS", "PIK3CA"],
    "ovarian":           ["PIK3CA", "AKT1", "PTEN", "BRCA1", "BRCA2"],
    "gist":              ["KIT", "PDGFRA", "BRAF"],
    "prostate":          ["AR", "PIK3CA", "PTEN", "AKT1", "TP53"],
}

def _get_disease_genes(disease_type):
    dt = disease_type.lower()
    for key, genes in _DISEASE_GENE_PANELS.items():
        if key in dt:
            return genes
    return []


def build_relevant_findings(key_variants, enriched, meta):
    disease_raw = meta.get("sampleDiseaseType", "")
    # Use first segment before "/" for display (e.g. "Lung Cancer/Adenocarcinoma" → "Lung Cancer")
    disease_display = disease_raw.split("/")[0].strip() if disease_raw else "Detected Cancer"

    panel_genes = _get_disease_genes(disease_raw)

    # Build gene → variant lookup from key variants
    detected = {}
    for v in key_variants:
        if v["gene"] not in detected:
            detected[v["gene"]] = v

    if not panel_genes:
        # No disease mapping — show all detected variants in a simple table
        if not detected:
            return "<p class='empty'>No key variants detected.</p>"
        rows = "".join(
            f"<tr><td><strong>{h(v['gene'])}</strong></td>"
            f"<td class='finding-detected'>{h(v['gene'])} {h(v['protein'])} {h(v['coding'])}</td></tr>"
            for v in key_variants
        )
        return (f"<p class='note'>No specific gene panel configured for &ldquo;{h(disease_raw)}&rdquo;. "
                f"Showing all detected key variants.</p>"
                f"<table><thead><tr><th>Gene</th><th>Finding</th></tr></thead>"
                f"<tbody>{rows}</tbody></table>")

    # Split panel hits into two halves for the two-column layout
    panel_items = [(g, detected.get(g)) for g in panel_genes]
    mid = (len(panel_items) + 1) // 2
    left_col  = panel_items[:mid]
    right_col = panel_items[mid:]
    while len(right_col) < len(left_col):
        right_col.append(None)

    def _cell(item):
        if item is None:
            return "<td></td><td></td>"
        gene, v = item
        if v:
            enc  = get_enc(enriched, v)
            tier = enc.get("tier", "IV")
            tier_color = enc.get("tier_color", TIER_COLORS["IV"])
            tier_badge = (f"<span style='font-size:0.75em;background:{tier_color};"
                          f"color:#fff;padding:1px 5px;border-radius:3px;"
                          f"margin-left:6px;'>{h(tier)}</span>")
            label = f"{h(gene)} {h(v['protein'])} {h(v['coding'])}"
            return (f"<td><strong>{h(gene)}</strong></td>"
                    f"<td class='finding-detected'>{label}{tier_badge}</td>")
        return (f"<td><strong>{h(gene)}</strong></td>"
                f"<td class='finding-none'>None detected</td>")

    rows = "".join(
        f"<tr>{_cell(l)}{_cell(r)}</tr>"
        for l, r in zip(left_col, right_col)
    )
    panel_html = (
        f"<p class='finding-subtitle'>Relevant findings associated with "
        f"<strong>{h(disease_display)}</strong></p>"
        f"<table class='finding-table'>"
        f"<thead><tr><th>Gene</th><th>Finding</th><th>Gene</th><th>Finding</th></tr></thead>"
        f"<tbody>{rows}</tbody></table>"
    )

    # Other findings: detected variants whose gene is not in the panel
    others = [v for g, v in detected.items() if g not in panel_genes]
    other_html = ""
    if others:
        items_html = "".join(
            f"<span class='other-finding-item'>"
            f"{h(v['gene'])} {h(v['protein'])} {h(v['coding'])}"
            f"</span>"
            for v in others
        )
        other_html = f"<div class='other-findings-block'><strong>Other Findings</strong>{items_html}</div>"

    return panel_html + other_html


def build_variant_description(key_variants, enriched):
    blocks = []
    for v in key_variants:
        enc = get_enc(enriched, v)
        gene_desc = enc.get("gene_description", "")
        var_desc  = enc.get("variant_description", "")
        if not gene_desc and not var_desc:
            continue

        variant_label = f"{h(v['gene'])} {h(v['protein'])} {h(v['coding'])}"

        # ── Potential Relevance: synthesise from evidence items ────────────
        predictive     = enc.get("predictive", [])
        therapies_this = enc.get("therapies_this", [])
        therapies_other= enc.get("therapies_other", [])
        n_trials       = len(enc.get("clinical_trials", []))
        parts = []

        top_this = [t for t in therapies_this
                    if t.get("level") in ("A", "B")
                    and t.get("significance", "").upper()
                       not in ("RESISTANCE", "ADVERSE_RESPONSE")]
        if top_this:
            drugs   = ", ".join(t["drug"] for t in top_this[:3])
            levels  = "/".join(sorted(set(t["level"] for t in top_this[:3])))
            disease = top_this[0].get("disease", "")
            prefix  = "FDA-approved therapy" if "A" in levels else f"Level {levels} evidence"
            parts.append(f"{prefix}: {drugs} for {disease}.")

        top_other = [t for t in therapies_other
                     if t.get("level") in ("A", "B")
                     and t.get("significance", "").upper()
                        not in ("RESISTANCE", "ADVERSE_RESPONSE")]
        if top_other:
            drugs_o    = ", ".join(t["drug"] for t in top_other[:2])
            diseases_o = ", ".join(dict.fromkeys(
                t.get("disease", "") for t in top_other[:2] if t.get("disease")))
            parts.append(f"Level A/B evidence for {drugs_o} in {diseases_o} (other cancer type).")

        resistance = [item for item in predictive
                      if item.get("significance", "").upper()
                         in ("RESISTANCE", "ADVERSE_RESPONSE")]
        if resistance:
            r_drugs = ", ".join(
                ", ".join(t["name"] for t in item.get("therapies", []) if t.get("name"))
                for item in resistance[:2]
            )
            if r_drugs:
                parts.append(f"Resistance to {r_drugs} has been reported.")

        if n_trials:
            parts.append(f"{n_trials} clinical trial(s) identified via ClinicalTrials.gov.")

        if not parts:
            parts.append("No predictive clinical evidence identified for this variant in CIViC.")

        potential_rel = " ".join(parts)

        # ── Build subsections ──────────────────────────────────────────────
        subsections = []
        if gene_desc:
            subsections.append(
                f"<div class='desc-subsection'>"
                f"<p><span class='desc-label'>Background:</span> {h(gene_desc)}</p>"
                f"</div>")
        if var_desc:
            subsections.append(
                f"<div class='desc-subsection'>"
                f"<p><span class='desc-label'>Alterations and Prevalence:</span> {h(var_desc)}</p>"
                f"</div>")
        subsections.append(
            f"<div class='desc-subsection'>"
            f"<p><span class='desc-label'>Potential Relevance:</span> {h(potential_rel)}</p>"
            f"</div>")

        blocks.append(
            f"<div class='variant-block'>"
            f"<div class='variant-block-title'>{variant_label}</div>"
            f"{''.join(subsections)}"
            f"</div>")

    if not blocks:
        return "<p class='empty'>No variant description available from CIViC for key variants.</p>"
    return "\n".join(blocks)


def build_cnv_table(cnv_variants):
    if not cnv_variants:
        return "<p class='empty'>No copy number alterations detected.</p>"
    rows = []
    for v in cnv_variants:
        rows.append(f"""
      <tr>
        <td><strong>{h(v['gene'])}</strong></td>
        <td>{h(v['chrom'])}</td>
        <td class="mono">{h(str(v['pos']))}–{h(str(v['end']))}</td>
        <td style="text-align:center;">{v['raw_cn']}</td>
        <td style="text-align:center;">{v['ref_cn']}</td>
        <td>{cn_badge(v['cn_call'])}</td>
        <td style="text-align:center;">{h(str(v['num_tiles']))}</td>
      </tr>""")
    return f"""
<table>
  <thead><tr><th>Gene</th><th>Chromosome</th><th>Region</th>
    <th>Raw CN</th><th>Ref CN</th><th>Call</th><th>Tiles</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>"""


def build_fusion_section(fusion_calls, metadata):
    overall = metadata.get("FusionSampleOverallCall", "NEGATIVE").split(",")[0].strip()
    if overall == "NEGATIVE" and not fusion_calls:
        return '<div class="fusion-negative">&#10003; Fusion Overall Call: <strong>NEGATIVE</strong> — No fusion events detected.</div>'
    rows = []
    for f in fusion_calls[:50]:
        rows.append(f"""
      <tr>
        <td><strong>{h(f['gene'])}</strong></td>
        <td style="font-size:0.85em;">{h(f['id'])}</td>
        <td>{h(f['svtype'])}</td>
        <td style="font-size:0.85em;">{h(f.get('pass_reason',''))}</td>
      </tr>""")
    return f"""
<p><strong>Overall call: {h(overall)}</strong></p>
<table>
  <thead><tr><th>Gene</th><th>ID</th><th>Type</th><th>Pass Reason</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>"""


def build_genes_assayed(metadata):
    dna_genes = ("AKT1, AKT2, AKT3, ALK, AR, ARAF, BRAF, CDK4, CDKN2A, CHEK2, CTNNB1, EGFR, "
                 "ERBB2, ERBB3, ERBB4, ESR1, FGFR1, FGFR2, FGFR3, FGFR4, FLT3, GNA11, GNAQ, GNAS, "
                 "HRAS, IDH1, IDH2, KIT, KRAS, MAP2K1, MAP2K2, MET, MTOR, NRAS, NTRK1, NTRK2, NTRK3, "
                 "PDGFRA, PIK3CA, PTEN, RAF1, RET, ROS1, SMO, TP53")
    cnv_genes = "ALK, AR, CD274, CDKN2A, EGFR, ERBB2, ERBB3, FGFR1, FGFR2, FGFR3, KRAS, MET, PIK3CA, PTEN"
    fusion_genes = "ALK, AR, BRAF, EGFR, ESR1, FGFR1, FGFR2, FGFR3, MET, NRG1, NTRK1, NTRK2, NTRK3, NUTM1, RET, ROS1, RSPO2, RSPO3"
    return f"""
<div class="method-grid">
  <div class="method-box">
    <h4>DNA Sequence Variants ({dna_genes.count(',')+1} genes)</h4>
    <p class="gene-list">{h(dna_genes)}</p>
  </div>
  <div class="method-box">
    <h4>Copy Number Variations ({cnv_genes.count(',')+1} genes)</h4>
    <p class="gene-list">{h(cnv_genes)}</p>
  </div>
  <div class="method-box" style="grid-column:1/-1;">
    <h4>Fusions ({fusion_genes.count(',')+1} genes)</h4>
    <p class="gene-list">{h(fusion_genes)}</p>
  </div>
</div>"""


def build_methodology(meta):
    source = meta.get("source", "")
    tvc_m = re.search(r"tvc\s+([\d.\-]+)", source, re.I)
    tvc_v = tvc_m.group(1) if tvc_m else "N/A"
    ann = meta.get("annotationSources", "N/A").strip("[]").replace(",", ", ")
    return f"""
<div class="method-grid">
  <div class="method-box">
    <h4>Assay Platform</h4>
    <p>Oncomine Precision Assay (NGS) using Ion Torrent technology.
       Variant calling by Torrent Variant Caller (TVC) v{h(tvc_v)}.
       Ion Reporter Software v{h(meta.get("IonReporterSoftwareVersion","N/A"))}.</p>
  </div>
  <div class="method-box">
    <h4>Annotation Databases</h4>
    <p>{h(ann)}</p>
  </div>
  <div class="method-box">
    <h4>Workflow</h4>
    <p>{h(meta.get("IonReporterWorkflowName","N/A"))} (v{h(meta.get("IonReporterWorkflowVersion","N/A"))})</p>
  </div>
  <div class="method-box">
    <h4>Oncomine Variant Annotation Tool</h4>
    <p>Version {h(meta.get("OncomineVariantAnnotationToolVersion","N/A"))}<br>
       Ruleset: {h(meta.get("OncomineVariantAnnotationToolRuleset","N/A"))}</p>
  </div>
  <div class="method-box" style="grid-column:1/-1;">
    <h4>Clinical Data Sources</h4>
    <p><strong>CIViC</strong> (civicdb.org) — Griffith et al. Nat Genet 2017. GraphQL API, accepted evidence.<br>
       <strong>ClinicalTrials.gov</strong> v2 API — recruiting and active interventional trials.<br>
       <strong>MyVariant.info</strong> — aggregated ClinVar / COSMIC / dbNSFP annotations.<br>
       API responses cached 7 days in <em>vcf_report_cache.json</em>.</p>
  </div>
  <div class="method-box" style="grid-column:1/-1;">
    <h4>Limitations &amp; Disclaimer</h4>
    <p>This report is for research use only. Findings should be correlated with clinical presentation
       and confirmed by orthogonal methods before clinical action. Coverage of clinical annotations may
       not be exhaustive. The assay does not detect large structural variants, deep intronic variants,
       or gross chromosomal abnormalities.</p>
  </div>
</div>"""


# ── CSS ────────────────────────────────────────────────────────────────────────

CSS = """
:root { --primary:#1a3a5c; --accent:#2980b9; --light:#f0f4f8; --border:#d5dbe3; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'Segoe UI',Arial,sans-serif; font-size:13px; color:#2c3e50; background:#e8edf2; }
.page { max-width:990px; margin:0 auto; background:white; box-shadow:0 0 24px rgba(0,0,0,.15); }
.header { background:var(--primary); color:white; padding:22px 32px 18px; }
.header h1 { font-size:1.55em; letter-spacing:0.5px; }
.header .subtitle { font-size:0.88em; opacity:.7; margin-top:4px; }
.header-meta { display:flex; gap:36px; margin-top:16px; flex-wrap:wrap; }
.header-meta div { font-size:0.82em; }
.header-meta strong { display:block; color:#aed6f1; font-size:0.8em; text-transform:uppercase; letter-spacing:.5px; margin-bottom:2px; }
.toc { background:#f7f9fc; padding:14px 32px; border-bottom:2px solid var(--border); }
.toc h3 { font-size:0.85em; color:var(--primary); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
.toc ol { padding-left:20px; }
.toc li { margin:3px 0; }
.toc a { color:var(--accent); text-decoration:none; font-size:0.88em; }
.toc a:hover { text-decoration:underline; }
.section { padding:20px 32px; border-bottom:1px solid var(--border); }
.section:last-child { border-bottom:none; }
.section-title { font-size:1em; font-weight:700; color:var(--primary); text-transform:uppercase;
                 letter-spacing:0.8px; border-left:4px solid var(--accent);
                 padding-left:10px; margin-bottom:14px; }
.qc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(155px,1fr)); gap:10px; }
.qc-card { background:var(--light); border-radius:6px; padding:9px 13px; border-top:3px solid var(--accent); }
.qc-card .label { font-size:0.73em; color:#7f8c8d; text-transform:uppercase; letter-spacing:.3px; }
.qc-card .value { font-size:1.1em; font-weight:700; color:var(--primary); margin-top:2px; }
.badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:0.8em; font-weight:600; color:white; white-space:nowrap; }
.badge-pass { background:#d5f5e3 !important; color:#1e8449 !important; }
.badge-fail { background:#fadbd8 !important; color:#922b21 !important; }
table { width:100%; border-collapse:collapse; font-size:0.87em; margin-top:8px; }
th { background:var(--primary); color:white; padding:8px 10px; text-align:left; font-weight:600; font-size:0.85em; }
td { padding:7px 10px; border-bottom:1px solid #eaecef; vertical-align:top; }
tr:nth-child(even) td { background:#fafbfc; }
tr:hover td { background:#f0f4f8; }
.mono { font-family:'Courier New',monospace; font-size:0.93em; }
.variant-block { margin-bottom:18px; border:1px solid var(--border); border-radius:6px; overflow:hidden; }
.variant-block-title { background:#eaf0f7; color:var(--primary); font-weight:700; padding:8px 14px; font-size:0.93em; border-bottom:1px solid var(--border); }
.variant-block table th { background:#2c4f72; }
.alert-legend { margin-bottom:14px; font-size:0.88em; display:flex; gap:20px; flex-wrap:wrap; }
.alert-entry { padding:12px 16px; border-bottom:1px solid #eee; }
.alert-entry:last-child { border-bottom:none; }
.alert-header { display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap; }
.alert-meta { display:flex; gap:20px; flex-wrap:wrap; font-size:0.84em; color:#555; margin-bottom:6px; }
.alert-statement { font-size:0.87em; color:#2c3e50; line-height:1.55; margin-bottom:4px; }
.alert-ref { font-size:0.8em; color:#7f8c8d; }
.desc-subsection { margin:10px 14px; }
.desc-subsection h4 { color:var(--primary); font-size:0.9em; margin-bottom:4px; }
.desc-subsection p { font-size:0.87em; line-height:1.6; color:#444; }
.method-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.method-box { background:var(--light); border-radius:6px; padding:12px 16px; }
.method-box h4 { color:var(--primary); margin-bottom:6px; font-size:0.88em; }
.method-box p { color:#555; line-height:1.5; font-size:0.84em; }
.gene-list { font-family:monospace; font-size:0.82em; color:#2c3e50; line-height:1.7; }
.fusion-negative { background:#eafaf1; border:1px solid #a9dfbf; border-radius:6px; padding:12px 18px; color:#1e8449; font-size:0.92em; }
.empty { color:#999; font-style:italic; font-size:0.9em; }
.note { font-size:0.82em; color:#7f8c8d; margin-bottom:8px; line-height:1.5; }
.footer { background:var(--primary); color:#aab7c4; font-size:0.78em; padding:14px 32px; text-align:center; }
.finding-subtitle { font-size:0.97em; color:#2c3e50; margin-bottom:8px; }
.finding-table { width:100%; border-collapse:collapse; margin-bottom:10px; }
.finding-table th { background:var(--primary); color:#fff; padding:6px 10px; font-size:0.82em; text-align:left; }
.finding-table td { padding:5px 10px; border-bottom:1px solid #eee; font-size:0.88em; vertical-align:middle; }
.finding-table tr:nth-child(even) td { background:#f8f9fa; }
.finding-detected { font-style:italic; font-weight:600; color:#1a5276; }
.finding-none { color:#999; }
.other-findings-block { margin-top:10px; padding:10px 14px; background:#f4f6f7; border-left:3px solid #7f8c8d; border-radius:4px; }
.other-findings-block strong { display:block; margin-bottom:6px; color:#2c3e50; }
.other-finding-item { display:inline-block; font-style:italic; font-size:0.88em; color:#34495e; margin-right:18px; margin-top:2px; }
.desc-gene-name { font-size:0.88em; color:#7f8c8d; font-style:italic; margin:-6px 0 10px 0; }
.desc-label { font-weight:700; color:#1a5276; }
.desc-subsection { margin-bottom:10px; }
.desc-subsection p { margin:4px 0; line-height:1.65; font-size:0.9em; }
@media print { body { background:white; } .page { box-shadow:none; max-width:100%; } .toc { display:none; } }
"""


# ── HTML Assembly ──────────────────────────────────────────────────────────────

def generate_html(data, enriched, af_threshold, vcf_path):
    meta = data["metadata"]
    snv = data["snv_variants"]
    low_af = data["low_af_variants"]
    sample_name = data["sample_name"]
    key_variants = [v for v in snv if v["af"] >= 0.01]   # AF >= 1%: clinical sections

    analysis_name = meta.get("IonReporterAnalysisName", "N/A")
    disease_type = meta.get("sampleDiseaseType", "N/A")
    reference = meta.get("reference", "N/A")
    raw_date = meta.get("fileDate", "")
    try:
        file_date = datetime.strptime(raw_date, "%Y%m%d").strftime("%d %b %Y")
    except Exception:
        file_date = raw_date or "N/A"

    header = f"""
<div class="header">
  <h1>Next-Generation Sequencing Report</h1>
  <div class="subtitle">Comprehensive Genomic Profiling &bull; Oncomine Precision Assay</div>
  <div class="header-meta">
    <div><strong>Sample / Lab ID</strong>{h(sample_name)}</div>
    <div><strong>Analysis Name</strong>{h(analysis_name)}</div>
    <div><strong>Disease Type</strong>{h(disease_type)}</div>
    <div><strong>Reference Genome</strong>{h(reference)}</div>
    <div><strong>Report Date</strong>{datetime.now().strftime('%d %b %Y')}</div>
    <div><strong>File Date</strong>{h(file_date)}</div>
  </div>
</div>"""

    toc = """
<div class="toc">
  <h3>Table of Contents</h3>
  <ol>
    <li><a href="#s-qc">Quality Control Summary</a></li>
    <li><a href="#s-relevant">Relevant Findings</a></li>
    <li><a href="#s-key">Key Variants — SNV / Indel</a></li>
    <li><a href="#s-nonkey">Non-Key / Low-AF Variants</a></li>
    <li><a href="#s-clinical">Clinical Relevance of Detected Variants</a></li>
    <li><a href="#s-therapy">Relevant Therapy Summary</a></li>
    <li><a href="#s-alerts">Alerts Informed by Public Data Sources</a></li>
    <li><a href="#s-trials">Clinical Trials Summary</a></li>
    <li><a href="#s-description">Variant Description</a></li>
    <li><a href="#s-genes">Genes Assayed</a></li>
    <li><a href="#s-method">Methodology</a></li>
  </ol>
</div>"""

    footer = f"""
<div class="footer">
  Generated by vcf_report_generator.py &bull; {datetime.now().strftime('%Y-%m-%d %H:%M')} &bull;
  VCF: {h(Path(vcf_path).name)} &bull; Sample: {h(sample_name)} &bull; Reference: {h(reference)}<br>
  Clinical data: CIViC &bull; ClinicalTrials.gov &bull; MyVariant.info.
  This report is for research use only. Not for clinical diagnostic use without independent validation.
</div>"""

    body = "\n".join([
        header, toc,
        section("Quality Control Summary", build_patient_qc(meta, sample_name), "s-qc"),
        section("Relevant Findings",
                build_relevant_findings(key_variants, enriched, meta), "s-relevant"),
        section(f"Key Variants — SNV / Indel "
                f"<span style='font-size:0.75em;font-weight:400;color:#aaa;'>AF &ge; {af_threshold*100:.1f}%</span>",
                build_key_variants_table(snv, enriched), "s-key"),
        section("Non-Key / Low Allele-Frequency Variants",
                build_non_key_table([v for v in low_af if v["af"] >= 0.002], af_threshold), "s-nonkey"),
        section("Clinical Relevance of Detected Variants",
                build_clinical_relevance(key_variants, enriched), "s-clinical"),
        section("Relevant Therapy Summary",
                build_therapy_summary(key_variants, enriched), "s-therapy"),
        section("Alerts Informed by Public Data Sources",
                build_alerts(key_variants, enriched), "s-alerts"),
        section("Clinical Trials Summary",
                build_clinical_trials(key_variants, enriched), "s-trials"),
        section("Variant Description",
                build_variant_description(key_variants, enriched), "s-description"),
        section("Genes Assayed", build_genes_assayed(meta), "s-genes"),
        section("Methodology", build_methodology(meta), "s-method"),
        footer,
    ])

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>NGS Report — {h(sample_name)}</title>
<style>{CSS}</style>
</head>
<body>
<div class="page">
{body}
</div>
</body>
</html>"""


# ── Main ───────────────────────────────────────────────────────────────────────

def generate_report(vcf_path, output_path, af_threshold=0.005, no_cache=False,
                    civic_db_path=None):
    print(f"Parsing VCF: {vcf_path}")
    data = parse_vcf(vcf_path, af_threshold=af_threshold)
    meta = data["metadata"]
    snv = data["snv_variants"]
    low = data["low_af_variants"]
    print(f"  SNV/indel (AF >= {af_threshold*100:.1f}%): {len(snv)}")
    print(f"  Low-AF variants:  {len(low)}")

    # CIViC vector DB (optional semantic fallback)
    civic_db = load_civic_vectordb(civic_db_path)
    if civic_db is not None:
        print(f"CIViC vector DB: loaded ({civic_db.count()} variants)")
    else:
        print("CIViC vector DB: not found (run build_civic_db.py to enable semantic matching)")

    # API cache
    cache_path = str(Path(output_path).parent / "vcf_report_cache.json")
    cache = {} if no_cache else load_cache(cache_path)
    if no_cache:
        print("Cache: disabled (--no-cache)")
    else:
        print(f"Cache: {cache_path}")

    # Enrich key variants (AF >= 1%) via live APIs
    disease_type = meta.get("sampleDiseaseType", "")
    key_variants = [v for v in snv if v["af"] >= 0.01]
    if not REQUESTS_AVAILABLE:
        print("WARNING: requests not available — skipping API enrichment")
        enriched = {}
    elif key_variants:
        print(f"Enriching {len(key_variants)} key variant(s) via CIViC / ClinicalTrials.gov / MyVariant.info ...")
        enriched = enrich_all(key_variants, disease_type, cache, cache_path, no_cache, civic_db)
    else:
        enriched = {}

    html_out = generate_html(data, enriched, af_threshold, vcf_path)
    with open(output_path, "w", encoding="utf-8") as fh:
        fh.write(html_out)
    print(f"Report written: {output_path}")


def main():
    print()
    parser = argparse.ArgumentParser(
        description="Generate an HTML genomics report from an annotated VCF file.")
    parser.add_argument("vcf", help="Path to annotated VCF file")
    parser.add_argument("--output", "-o", default=None,
                        help="Output HTML file (default: <vcf>_report.html)")
    parser.add_argument("--af-threshold", "-t", type=float, default=0.005,
                        help="Min allele frequency for key variant table (default: 0.005)")
    parser.add_argument("--db-path", default=None,
                        help="Path to CIViC ChromaDB directory (default: ./civic_chroma_db)")
    parser.add_argument("--no-cache", action="store_true",
                        help="Force fresh API calls, ignore cached results")
    args = parser.parse_args()

    vcf_path = Path(args.vcf)
    if not vcf_path.exists():
        print(f"ERROR: VCF file not found: {vcf_path}", file=sys.stderr)
        sys.exit(1)

    output_path = (Path(args.output) if args.output
                   else vcf_path.with_name(vcf_path.stem + "_report.html"))
    print(args.db_path)
    print("..............")
    generate_report(str(vcf_path), str(output_path),
                    af_threshold=args.af_threshold,
                    no_cache=args.no_cache,
                    # civic_db_path=args.db_path)
                    civic_db_path=str("./civic_chroma_db"))




if __name__ == "__main__":
    main()
