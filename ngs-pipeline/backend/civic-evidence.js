import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { queryVariants, referenceBuild } from './vcf-results.js'

const sourceUrl = 'https://civicdb.org/downloads/nightly/'
const files = ['nightly-VariantSummaries.tsv', 'nightly-ClinicalEvidenceSummaries.tsv']
const chromosomeVersions = {
  // RefSeq primary chromosome versions from the Genome Reference Consortium assembly tables.
  GRCh37: [10, 11, 11, 11, 9, 11, 13, 10, 11, 10, 9, 11, 10, 8, 9, 9, 10, 9, 9, 10, 8, 10, 10, 9],
  GRCh38: [11, 12, 12, 12, 10, 12, 14, 11, 12, 11, 10, 12, 11, 9, 10, 10, 11, 10, 10, 11, 9, 11, 11, 10],
}

let cachedRelease

async function evidenceRelease() {
  if (cachedRelease?.expires > Date.now()) return cachedRelease.promise
  const promise = loadRelease(process.env.NGS_CIVIC_DIR).catch((error) => {
    cachedRelease = undefined
    throw error
  })
  cachedRelease = { promise, expires: Date.now() + 60 * 60 * 1000 }
  return promise
}

async function loadRelease(directory) {
  const [variants, evidence] = await Promise.all(files.map(async (file) => {
    if (directory) return readFile(path.join(directory, file), 'utf8')
    const response = await fetch(new URL(file, sourceUrl), { signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error('CIViC release download failed.')
    return response.text()
  }))

  const variantIndex = new Map()
  for (const variant of tsvRows(variants, ['variant_id', 'single_variant_molecular_profile_id', 'hgvs_descriptions', 'reference_build', 'chromosome', 'start', 'reference_bases', 'variant_bases', 'is_flagged'])) {
    if (!/^\d+$/.test(variant.variant_id) || !/^\d+$/.test(variant.single_variant_molecular_profile_id) || variant.is_flagged.toLowerCase() === 'true') continue
    const build = referenceBuild(variant.reference_build)
    const exactKeys = [
      genomicKey(build, variant.chromosome, Number(variant.start), variant.reference_bases, variant.variant_bases),
      ...variant.hgvs_descriptions.split(',').map((hgvs) => hgvsKey(hgvs)),
    ]
    for (const key of new Set(exactKeys.filter(Boolean))) {
      append(variantIndex, key, {
        civicVariantId: Number(variant.variant_id),
        profileId: variant.single_variant_molecular_profile_id,
      })
    }
  }

  const evidenceIndex = new Map()
  for (const row of tsvRows(evidence, ['molecular_profile_id', 'disease', 'doid', 'evidence_status', 'evidence_id', 'evidence_type', 'evidence_level', 'evidence_direction', 'significance', 'evidence_statement', 'citation', 'variant_origin', 'last_review_date', 'is_flagged'])) {
    if (row.evidence_status.toLowerCase() !== 'accepted' || row.is_flagged.toLowerCase() === 'true' || !/^\d+$/.test(row.evidence_id)) continue
    append(evidenceIndex, row.molecular_profile_id, {
      evidenceId: Number(row.evidence_id),
      url: `https://civicdb.org/links/evidence_items/${row.evidence_id}`,
      disease: row.disease,
      diseaseOntologyId: doid(row.doid),
      type: row.evidence_type,
      level: row.evidence_level,
      direction: row.evidence_direction,
      significance: row.significance,
      statement: row.evidence_statement,
      citation: row.citation,
      variantOrigin: row.variant_origin,
      lastReviewed: row.last_review_date || null,
    })
  }
  return { variantIndex, evidenceIndex, source: { database: 'CIViC', mode: directory ? 'local_snapshot' : 'nightly_release', loadedAt: new Date().toISOString(), files } }
}

function* tsvRows(text, requiredFields) {
  const input = text.replace(/^\uFEFF/, '').replace(/\r?\n$/, '') + '\n'
  const cell = /(?:"((?:[^"]|"")*)"|([^"\t\r\n][^\t\r\n]*|))(\t|\r?\n)/gy
  let header
  let row = []
  let end = 0
  for (const match of input.matchAll(cell)) {
    end += match[0].length
    row.push(match[1]?.replaceAll('""', '"') ?? match[2])
    if (match[3] === '\t') continue
    if (!header) {
      header = row
      if (!requiredFields.every((field) => header.includes(field))) throw new Error('CIViC release is missing required columns.')
    } else {
      if (header.length !== row.length) throw new Error('CIViC release has an invalid row.')
      yield Object.fromEntries(header.map((field, index) => [field, row[index]]))
    }
    row = []
  }
  if (end !== input.length || row.length || !header) throw new Error('CIViC release has invalid TSV formatting.')
}

function append(index, key, item) {
  if (!index.has(key)) index.set(key, [])
  index.get(key).push(item)
}

function chromosomeNumber(chromosome) {
  const value = chromosome.replace(/^chr/i, '').toUpperCase()
  if (value === 'X') return 23
  if (value === 'Y') return 24
  return /^(?:[1-9]|1\d|2[0-2])$/.test(value) ? Number(value) : 0
}

function genomicKey(build, chrom, position, ref, alt) {
  if (!build || !Number.isSafeInteger(position) || position < 1 || !/^[ACGT]+$/i.test(ref) || !/^[ACGT]+$/i.test(alt) || ref.toUpperCase() === alt.toUpperCase()) return null
  const number = chromosomeNumber(chrom)
  const version = chromosomeVersions[build]?.[number - 1]
  return version ? `NC_${String(number).padStart(6, '0')}.${version}:${position}:${ref.toUpperCase()}:${alt.toUpperCase()}` : null
}

function hgvsKey(hgvs) {
  const value = hgvs?.trim()
  if (!value) return null
  const substitution = /^(NC_\d{6}\.\d+):g\.(\d+)([ACGT])>([ACGT])$/i.exec(value)
  if (substitution) return substitution.slice(1).join(':').toUpperCase()
  return /^(?:ENST\d+|N[MR]_\d+)\.\d+:[cn]\..+$/.test(value) ? value : null
}

function doid(value) {
  const id = /^(?:DOID[:_])?(\d+)$/i.exec(value.trim())?.[1]
  return id ? `DOID:${id}` : null
}

function diseaseName(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function getClinicalEvidence({ disease, variantId, offset = 0, limit = 20, ...selection }) {
  if (!disease?.trim()) return { status: 'disease_required', message: 'Provide the disease name or Disease Ontology ID for the evidence lookup.' }
  let release
  try {
    release = await evidenceRelease()
  } catch {
    return { status: 'source_unavailable', message: 'The CIViC release is unavailable. Try again or configure a local CIViC snapshot.' }
  }
  const diseaseId = doid(disease)
  const name = diseaseName(disease)
  const items = []
  let total = 0
  let variantsChecked = 0
  let variantsWithExactKeys = 0
  const context = await queryVariants(selection, (variant, { referenceBuild: build }) => {
    if (variantId && variantId !== variant.variantId) return
    variantsChecked++
    const keys = [
      genomicKey(build, variant.chrom, variant.position, variant.ref, variant.alt),
      ...variant.annotations.map(({ hgvsC }) => hgvsKey(hgvsC)),
    ]
    const exactKeys = new Set(keys.filter(Boolean))
    if (exactKeys.size) variantsWithExactKeys++
    const seen = new Set()
    for (const key of exactKeys) {
      for (const match of release.variantIndex.get(key) ?? []) {
        for (const evidence of release.evidenceIndex.get(match.profileId) ?? []) {
          const diseaseMatches = diseaseId ? evidence.diseaseOntologyId === diseaseId : diseaseName(evidence.disease) === name
          if (!diseaseMatches || seen.has(evidence.evidenceId)) continue
          seen.add(evidence.evidenceId)
          if (total++ < offset || items.length >= limit) continue
          items.push({
            variantId: variant.variantId,
            genes: variant.genes,
            chrom: variant.chrom,
            position: variant.position,
            ref: variant.ref,
            alt: variant.alt,
            sourceRecord: variant.source,
            civicVariantId: match.civicVariantId,
            ...evidence,
          })
        }
      }
    }
  })
  if (variantId && !variantsChecked) throw new Error('The variant ID is unavailable for the selected sample and filter.')
  let status = 'no_matching_evidence'
  if (total) status = 'matched'
  else if (variantsChecked && !variantsWithExactKeys) status = 'insufficient_variant_identity'
  return {
    ...context,
    status,
    disease,
    filter: selection.filter ?? 'pass_or_unfiltered',
    variantsChecked,
    variantsWithExactKeys,
    total,
    nextOffset: items.length && offset + items.length < total ? offset + items.length : null,
    items,
    source: release.source,
  }
}
