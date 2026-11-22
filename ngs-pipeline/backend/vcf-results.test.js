import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { getClinicalEvidence } from './civic-evidence.js'
import { getVariant, listGenes, listResults, listVariants } from './vcf-results.js'

const header = [
  '##fileformat=VCFv4.2',
  '##reference=GRCh38',
  '##INFO=<ID=CSQ,Number=.,Type=String,Description="Format: Allele|Consequence|SYMBOL|Feature_type|Feature|HGVSc|ALLELE_NUM">',
  '##INFO=<ID=AF,Number=A,Type=Float,Description="Site allele frequency">',
  '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
  '##FORMAT=<ID=AD,Number=R,Type=Integer,Description="Allelic depths">',
  '##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read depth">',
  '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1\tS2',
].join('\n')

test('queries called VEP alleles, keeps sample context, and joins exact CIViC evidence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ngs-result-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previousRoot = process.env.NGS_RESULTS_ROOT
  const previousCivic = process.env.NGS_CIVIC_DIR
  t.after(() => {
    if (previousRoot === undefined) delete process.env.NGS_RESULTS_ROOT
    else process.env.NGS_RESULTS_ROOT = previousRoot
    if (previousCivic === undefined) delete process.env.NGS_CIVIC_DIR
    else process.env.NGS_CIVIC_DIR = previousCivic
  })
  process.env.NGS_RESULTS_ROOT = root
  process.env.NGS_CIVIC_DIR = root
  const directory = path.join(root, 'demo', 'variant_annotation')
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'annotated_variants.vcf.gz')
  const records = [
    'chr7\t55191822\t.\tT\tG,A\t.\t.\tAF=0.1,0.2;CSQ=G|missense_variant|EGFR|Transcript|ENST1|ENST1.1:c.1T>G|1,A|intron_variant|EGFR|Transcript|ENST1||2\tGT:AD:DP\t0/1:8,2,0:12\t0|2:5,0,5:10',
    'chr7\t55191830\t.\tA\tC\t.\tPASS\t.\tGT:AD:DP\t1/1:.:.\t./.:.:.',
    'chr7\t55191831\t.\tA\tG\t.\tLowQual\t.\tGT:AD:DP\t0/1:3,2:5\t0/0:5,0:5',
    'chr7\t55191832\t.\tATC\tA,AT\t.\tPASS\tCSQ=-|frameshift_variant|DEMO|Transcript|ENST2||\tGT:AD:DP\t1/2:4,3,3:10\t0/0:10,0,0:10',
  ]
  await writeFile(file, gzipSync([header, ...records, ''].join('\n')))
  const { items: [result] } = await listResults()
  assert.deepEqual(result.samples, ['S1', 'S2'])
  assert.equal(result.referenceBuild, 'GRCh38')
  await assert.rejects(listVariants({ resultId: result.resultId }), /exact sample name/)
  const selection = { resultId: result.resultId, sample: 'S1' }
  const variants = await listVariants({ ...selection, gene: 'egfr', annotated: true })
  assert.equal(variants.total, 1)
  const [hit] = variants.items
  assert.equal(hit.alt, 'G')
  assert.equal(hit.filterStatus, 'unfiltered')
  assert.equal(hit.sampleAlleleFraction.value, 0.2)
  assert.equal(hit.siteAlleleFrequency, 0.1)
  assert.equal(hit.depth, 12)
  const detail = await getVariant({ ...selection, variantId: hit.variantId })
  assert.equal(detail.annotations.items[0].consequences[0], 'missense_variant')
  await assert.rejects(getVariant({ ...selection, sample: 'S2', variantId: hit.variantId }), /not a called alternate allele/)
  assert.deepEqual((await listGenes(selection)).items, [{ gene: 'EGFR', count: 1 }])
  const unannotated = await listVariants({ ...selection, annotated: false, limit: 1 })
  assert.equal(unannotated.total, 3)
  assert.equal(unannotated.nextOffset, 1)
  assert.equal(unannotated.items[0].sampleAlleleFraction, null)
  assert.equal((await listVariants({ ...selection, annotated: false, offset: 1 })).items[0].unassignedAnnotationCountAtSite, 1)
  assert.equal((await listVariants({ ...selection, filter: 'filtered' })).total, 1)
  assert.equal((await getClinicalEvidence(selection)).status, 'disease_required')

  await writeFile(path.join(root, 'nightly-VariantSummaries.tsv'), [
    'variant_id\tsingle_variant_molecular_profile_id\thgvs_descriptions\treference_build\tchromosome\tstart\treference_bases\tvariant_bases\tis_flagged',
    '33\t33\tNC_000007.14:g.55191822T>G\tGRCh37\t7\t55259515\tT\tG\tfalse',
  ].join('\n'))
  await writeFile(path.join(root, 'nightly-ClinicalEvidenceSummaries.tsv'), [
    'molecular_profile_id\tdisease\tdoid\tevidence_status\tevidence_id\tevidence_type\tevidence_level\tevidence_direction\tsignificance\tevidence_statement\tcitation\tvariant_origin\tlast_review_date\tis_flagged',
    '33\tDemo carcinoma\t1\taccepted\t100\tpredictive\tB\tsupports\tsynthetic\t"Synthetic ""evidence""\nwith a second line."\tDemo citation\tsomatic\t2026-10-01\tfalse',
    '33\tDemo carcinoma\t1\tsubmitted\t101\tpredictive\tB\tsupports\tsynthetic\tUnaccepted\tDemo\tsomatic\t\tfalse',
    '33\tOther carcinoma\t2\taccepted\t102\tpredictive\tB\tsupports\tsynthetic\tOther disease\tDemo\tsomatic\t\tfalse',
  ].join('\n'))
  const evidence = await getClinicalEvidence({ ...selection, disease: 'DOID:1' })
  assert.equal(evidence.status, 'matched')
  assert.deepEqual(evidence.items.map(({ evidenceId, variantId }) => [evidenceId, variantId]), [[100, hit.variantId]])
  assert.equal(evidence.items[0].statement, 'Synthetic "evidence"\nwith a second line.')
  assert.equal(evidence.items[0].url, 'https://civicdb.org/links/evidence_items/100')
  assert.equal((await getClinicalEvidence({ ...selection, sample: 'S2', disease: 'Demo carcinoma' })).status, 'no_matching_evidence')
  await writeFile(file, gzipSync([header, records[0], ''].join('\n')))
  await assert.rejects(listVariants(selection), /Result ID is unavailable/)
})
