import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createGunzip } from 'node:zlib'
import VCF from '@gmod/vcf'
import { getDataRoot, isUnderDirectory } from './data-root.js'
import { patientDirectory, patientFolders } from './patient-folders.js'
import { completedOutputs, optional } from './stage-artifacts.js'

const vcfExtension = /\.vcf(?:\.gz)?$/i
const standardResult = /^annotated_variants\.vcf(?:\.gz)?$/i

async function findResults(patient) {
  const root = await getDataRoot()
  const candidates = new Map()
  const folders = patient === undefined ? await patientFolders(root) : [{ patient }]
  if (patient === undefined) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && vcfExtension.test(entry.name)) candidates.set(entry.name, undefined)
    }
  } else {
    await patientDirectory(root, patient)
  }
  for (const folder of folders) {
    const directory = path.join(folder.patient, 'variant_annotation')
    const absolute = path.join(root, directory)
    if (await optional(() => realpath(absolute)) !== absolute) continue
    const children = await readdir(absolute, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
      throw error
    })
    for (const child of children) {
      if (child.isFile() && standardResult.test(child.name)) candidates.set(path.join(directory, child.name), folder.patient)
    }
  }
  for await (const artifact of completedOutputs(root, patient)) {
    if (artifact.stage === 'vep' && artifact.kind === 'vcf') {
      candidates.set(path.relative(root, artifact.file), artifact.patient)
    }
  }
  const results = []
  for (const [candidate, owner] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const file = await realpath(path.join(root, candidate)).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!file || !isUnderDirectory(root, file)) continue
    const version = await stat(file, { bigint: true }).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!version?.isFile()) continue
    const resultId = createHash('sha256')
      .update(JSON.stringify([file, ...fileVersion(version)]))
      .digest('hex')
    results.push({ resultId, label: candidate.split(path.sep).join('/'), file, version, patient: owner })
  }
  return results
}

function fileVersion(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String)
}

async function assertCurrent(artifact) {
  const current = await stat(artifact.file, { bigint: true }).catch(() => null)
  if (!current || fileVersion(artifact.version).join() !== fileVersion(current).join()) {
    throw new Error('This result changed. Call list_results again to select its current version.')
  }
}

async function* lines(file) {
  const source = createReadStream(file)
  const input = /\.gz$/i.test(file) ? createGunzip() : source
  if (input !== source) {
    source.once('error', (error) => input.destroy(error))
    source.pipe(input)
  }
  let pending = ''
  try {
    for await (const chunk of input.setEncoding('utf8')) {
      const records = (pending + chunk).split('\n')
      pending = records.pop()
      if (pending.length > 16_000_000) throw new Error('A VCF line exceeds the supported length.')
      for (const record of records) yield record.replace(/\r$/, '')
    }
    if (pending) yield pending.replace(/\r$/, '')
  } finally {
    input.destroy()
    source.destroy()
  }
}

export function referenceBuild(text) {
  if (/\b(?:GRCh38|hg38)\b/i.test(text.replaceAll('_', ' '))) return 'GRCh38'
  if (/\b(?:GRCh37|hg19)\b/i.test(text.replaceAll('_', ' '))) return 'GRCh37'
  return null
}

async function* readVcf(file) {
  const header = []
  let parser
  let lineNumber = 0
  for await (const line of lines(file)) {
    lineNumber++
    if (!parser) {
      if (!line.startsWith('#')) throw new Error('The result has an invalid VCF header.')
      header.push(line)
      if (!line.startsWith('#CHROM\t')) continue
      parser = new VCF({ header: header.join('\n') })
      const description = parser.getMetadata('INFO', 'CSQ', 'Description')
      const format = typeof description === 'string' ? /\bFormat:\s*(.+)$/.exec(description)?.[1] : null
      const csqFields = format?.split('|').map((field) => field.trim()) ?? []
      const builds = new Set(header
        .filter((line) => /^##(?:reference|assembly|VEP)=/.test(line))
        .map(referenceBuild)
        .filter(Boolean))
      const build = builds.size === 1 ? [...builds][0] : null
      yield { samples: parser.samples, csqFields, referenceBuild: build }
    } else if (line && !line.startsWith('#')) {
      yield { record: parser.parseLine(line), lineNumber }
    }
  }
  if (!parser) throw new Error('The result is missing its VCF column header.')
}

function page(items, total, offset) {
  const next = offset + items.length
  return { total, nextOffset: items.length && next < total ? next : null, items }
}

export async function listResults({ offset = 0, limit = 20, patient } = {}) {
  const results = await findResults(patient)
  const items = []
  for (const artifact of results.slice(offset, offset + limit)) {
    const { resultId, label, patient } = artifact
    const rows = readVcf(artifact.file)
    try {
      const { value: header } = await rows.next()
      await assertCurrent(artifact)
      items.push({ resultId, label, patient, samples: header.samples, referenceBuild: header.referenceBuild, hasVepAnnotations: header.csqFields.includes('Allele') })
    } catch {
      items.push({ resultId, label, error: 'Unable to read the VCF header.' })
    } finally {
      await rows.return()
    }
  }
  return page(items, results.length, offset)
}

async function selectedResult(selection) {
  const artifact = (await findResults()).find((result) => result.resultId === selection.resultId)
  if (!artifact) throw new Error('Result ID is unavailable. Call list_results and choose a current result.')
  const rows = readVcf(artifact.file)
  try {
    const { value: header } = await rows.next()
    const sample = selection.sample ?? (header.samples.length === 1 ? header.samples[0] : null)
    if (!sample || !header.samples.includes(sample)) throw new Error('Select an exact sample name from list_results.')
    const context = { resultId: artifact.resultId, result: artifact.label, sample, referenceBuild: header.referenceBuild }
    return { artifact, rows, header, context }
  } catch (error) {
    await rows.return()
    throw error
  }
}

function alleleRepresentation(ref, alt) {
  let start = 0
  let end = alt.length
  while (start < end && start < ref.length && ref[start] === alt[start]) start++
  let refEnd = ref.length
  while (end > start && refEnd > start && ref[refEnd - 1] === alt[end - 1]) {
    refEnd--
    end--
  }
  return alt.slice(start, end) || '-'
}

function assignAnnotations(record, fields) {
  const alternatives = record.ALT ?? []
  const annotations = alternatives.map(() => [])
  const raw = record.INFO.CSQ ?? []
  const entries = Array.isArray(raw) ? raw : [raw]
  const positions = new Map(fields.map((name, index) => [name, index]))
  let unassigned = 0
  for (const entry of entries) {
    if (!entry) continue
    const columns = entry.split('|')
    const value = (name) => columns[positions.get(name)] || null
    let index = -1
    const number = value('ALLELE_NUM')
    if (number !== null) {
      const candidate = Number(number)
      if (Number.isInteger(candidate) && candidate >= 1 && candidate <= alternatives.length) index = candidate - 1
    } else if (value('Allele')) {
      const matches = alternatives.flatMap((alt, position) => {
        return alt === value('Allele') || alleleRepresentation(record.REF, alt) === value('Allele') ? [position] : []
      })
      if (matches.length === 1) index = matches[0]
    }
    if (index < 0) {
      unassigned++
      continue
    }
    annotations[index].push({
      gene: value('SYMBOL'),
      geneId: value('Gene'),
      transcript: value('Feature_type') === 'Transcript' ? value('Feature') : null,
      featureType: value('Feature_type'),
      consequences: value('Consequence')?.split('&') ?? [],
      impact: value('IMPACT'),
      hgvsC: value('HGVSc'),
      hgvsP: value('HGVSp'),
      canonical: value('CANONICAL') === 'YES',
    })
  }
  return { annotations, unassigned }
}

const depth = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
const fraction = (value) => Number.isFinite(value) && value >= 0 && value <= 1 ? value : null

function sampleVariants({ record, lineNumber }, header, sample, filter) {
  const status = record.FILTER === 'PASS' ? 'pass' : record.FILTER?.length ? 'filtered' : 'unfiltered'
  if (filter !== 'all' && (filter === 'pass_or_unfiltered' ? status === 'filtered' : filter !== status)) return []
  const call = record.SAMPLES()[sample]
  const gt = call?.GT?.[0]
  if (typeof gt !== 'string') return []
  const called = new Set(gt.split(/[/|]/).map((value) => /^[1-9]\d*$/.test(value) ? Number(value) : 0))
  const alternatives = record.ALT ?? []
  if (!alternatives.some((alt, index) => alt !== '*' && !alt.startsWith('<') && called.has(index + 1))) return []
  const { annotations, unassigned } = assignAnnotations(record, header.csqFields)
  const ad = call.AD ?? []
  const denominator = ad.length === alternatives.length + 1 && ad.every((value) => depth(value) !== null)
    ? ad.reduce((sum, value) => sum + value, 0)
    : 0
  return alternatives.flatMap((alt, index) => {
    const alleleIndex = index + 1
    if (!called.has(alleleIndex) || !/^[ACGTN]+$/i.test(alt)) return []
    const alternateReads = depth(ad[alleleIndex])
    return [{
      variantId: `${lineNumber}:${alleleIndex}`,
      chrom: record.CHROM,
      position: record.POS,
      ref: record.REF,
      alt,
      genotype: gt,
      filter: record.FILTER ?? '.',
      filterStatus: status,
      depth: depth(call.DP?.[0]),
      sampleAlleleFraction: denominator > 0 ? { value: alternateReads / denominator, alternateReads, totalAllelicReads: denominator, source: 'FORMAT/AD' } : null,
      sampleReportedAlleleFraction: fraction(call.AF?.[index]),
      siteAlleleFrequency: fraction(record.INFO.AF?.[index]),
      genes: [...new Set(annotations[index].map(({ gene }) => gene).filter(Boolean))],
      annotations: annotations[index],
      unassignedAnnotationCountAtSite: unassigned,
      source: { line: lineNumber, alleleIndex },
    }]
  })
}

export async function queryVariants(selection, visit) {
  const { artifact, rows, header, context } = await selectedResult(selection)
  try {
    for await (const row of rows) {
      for (const variant of sampleVariants(row, header, context.sample, selection.filter ?? 'pass_or_unfiltered')) {
        visit(variant, context)
      }
    }
    await assertCurrent(artifact)
    return context
  } finally {
    await rows.return()
  }
}

export async function listVariants({ offset = 0, limit = 20, gene, annotated, ...selection }) {
  const items = []
  let total = 0
  const context = await queryVariants(selection, (variant) => {
    if (gene && !variant.genes.some((symbol) => symbol.toUpperCase() === gene.toUpperCase())) return
    if (annotated !== undefined && annotated !== Boolean(variant.annotations.length)) return
    if (total++ < offset || items.length >= limit) return
    const { annotations, ...summary } = variant
    items.push({ ...summary, annotationCount: annotations.length })
  })
  return { ...context, filter: selection.filter ?? 'pass_or_unfiltered', ...page(items, total, offset) }
}

export async function listGenes({ offset = 0, limit = 20, ...selection }) {
  const genes = new Map()
  const context = await queryVariants(selection, (variant) => {
    for (const gene of variant.genes) genes.set(gene, (genes.get(gene) ?? 0) + 1)
  })
  const ordered = [...genes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const items = ordered.slice(offset, offset + limit).map(([gene, count]) => ({ gene, count }))
  return { ...context, filter: selection.filter ?? 'pass_or_unfiltered', ...page(items, genes.size, offset) }
}

export async function getVariant({ variantId, offset = 0, limit = 20, ...selection }) {
  const { artifact, rows, header, context } = await selectedResult(selection)
  const wantedLine = Number(variantId.split(':')[0])
  try {
    for await (const row of rows) {
      if (row.lineNumber > wantedLine) break
      if (row.lineNumber !== wantedLine) continue
      const found = sampleVariants(row, header, context.sample, 'all').find((variant) => variant.variantId === variantId)
      if (!found) break
      const { annotations, ...variant } = found
      await assertCurrent(artifact)
      return { ...context, variant, annotations: page(annotations.slice(offset, offset + limit), annotations.length, offset) }
    }
    throw new Error('That variant ID is not a called alternate allele in the selected result and sample.')
  } finally {
    await rows.return()
  }
}
