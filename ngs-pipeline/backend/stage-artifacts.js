import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isUnderDirectory } from './data-root.js'

export const runsFolder = '.stage-runs'
export const runIdPattern = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/
const types = [
  ['fastq', /\.(?:fq|fastq)(?:\.gz)?$/i],
  ['reference', /\.(?:fa|fasta|fna)$/i],
  ['bam', /\.bam$/i],
  ['vcf', /\.vcf(?:\.gz)?$/i],
  ['index', /\.(?:bai|csi|tbi|fai|dict|amb|ann|bwt|pac|sa)$/i],
  ['report', /\.html$/i],
  ['report', /_fastqc\.zip$/i],
  ['metrics', /(?:^|\/)dup_metrics\.txt$/i],
]

export async function optional(operation) {
  try {
    return await operation()
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined
    throw error
  }
}

export async function stageArtifact(file, label, boundary) {
  const kind = types.find(([, pattern]) => pattern.test(label))?.[0]
  if (!kind) return null
  const resolved = await optional(() => realpath(file))
  if (!resolved || (boundary && !isUnderDirectory(boundary, resolved))) return null
  const info = await optional(() => stat(resolved, { bigint: true }))
  if (!info?.isFile()) return null
  const version = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  const artifactId = createHash('sha256').update(resolved).update('\0').update(version).digest('hex')
  return { file: resolved, artifactId, label, kind, size: Number(info.size) }
}

export async function readStageRun(root, runId) {
  if (!runIdPattern.test(runId)) return undefined
  const expected = path.join(root, runsFolder, runId)
  if (await optional(() => realpath(expected)) !== expected) return undefined
  const file = path.join(expected, 'run.json')
  if (!(await optional(() => lstat(file)))?.isFile()) return undefined
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function stageRunOutputs(root, run) {
  if (!Array.isArray(run.outputs)) return []
  if (run.patient && Array.isArray(run.published)) {
    const boundary = path.join(root, run.patient)
    const published = await Promise.all(run.published.map(async ({ label, artifactId }) => {
      const artifact = await stageArtifact(path.join(root, label), label, boundary)
      return artifact?.artifactId === artifactId ? artifact : null
    }))
    if (published.length && published.every(Boolean)) return published
  }
  const directory = path.join(root, runsFolder, run.runId)
  const archived = await Promise.all(run.outputs.map(async (output) => {
    const file = path.join(directory, output)
    const label = path.relative(root, file).split(path.sep).join('/')
    return stageArtifact(file, label, directory)
  }))
  return archived.filter(Boolean)
}

export async function* completedOutputs(root, patient) {
  const parent = path.join(root, runsFolder)
  if (await optional(() => realpath(parent)) !== parent) return
  const entries = await readdir(parent, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const run = await readStageRun(root, entry.name)
    if (run?.status !== 'succeeded' || (patient !== undefined && run.patient !== patient)) continue
    for (const artifact of await stageRunOutputs(root, run)) {
      yield { ...artifact, stage: run.stage, patient: run.patient }
    }
  }
}

async function* dataFiles(root, directory, depth = 0, boundary = directory) {
  const entries = await optional(() => readdir(directory, { withFileTypes: true })) ?? []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory() && depth < 4) {
      yield* dataFiles(root, file, depth + 1, boundary)
    } else if (entry.isFile()) {
      const label = path.relative(root, file).split(path.sep).join('/')
      const artifact = await stageArtifact(file, label, boundary)
      if (artifact) yield artifact
    }
  }
}

export async function* stageInputs(root, directory) {
  yield* dataFiles(root, directory)
  yield* completedOutputs(root, path.basename(directory))
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const artifact = await stageArtifact(path.join(root, entry.name), entry.name, root)
    if (artifact?.kind === 'reference') yield artifact
  }
  if (process.env.NGS_REFERENCE_FASTA) {
    const reference = path.resolve(process.env.NGS_REFERENCE_FASTA)
    const artifact = await stageArtifact(reference, `Configured reference: ${path.basename(reference)}`)
    if (artifact?.kind === 'reference') yield artifact
  }
}

export function describeArtifact({ artifactId, label, kind, size }) {
  return { artifactId, label, kind, size }
}
