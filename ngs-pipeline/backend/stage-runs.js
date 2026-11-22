import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import path from 'node:path'
import { resolveStageParameters } from '../shared/stageParameters.js'
import { getDataRoot } from './data-root.js'
import { patientDirectory } from './patient-folders.js'
import { previewPatientOutputs, publishPatientOutputs } from './patient-outputs.js'
import { describeArtifact, optional, readStageRun, runIdPattern, runsFolder, stageArtifact, stageInputs, stageRunOutputs } from './stage-artifacts.js'

const stages = {
  fastqc: { input: 'fastq', endpoint: '/api/qc/run' },
  bbduk: { input: 'fastq', endpoint: '/api/trimming/bbduk' },
  alignment: { input: 'fastq', reference: true, endpoint: '/api/alignment/run' },
  'mark-duplicates': { input: 'bam', endpoint: '/api/post-alignment/mark-duplicates' },
  'read-groups': { input: 'bam', endpoint: '/api/variant-calling/add-read-groups' },
  'index-bam': { input: 'bam', endpoint: '/api/alignment/index-bam' },
  'prepare-reference': { input: 'reference', endpoint: '/api/variant-calling/prepare-reference' },
  'haplotype-caller': { input: 'bam', reference: true, endpoint: '/api/variant-calling/haplotype-caller' },
  vep: { input: 'vcf', reference: true, endpoint: '/api/variant-annotation/run' },
  'civic-report': { input: 'vcf', endpoint: '/api/downstream/civic-report' },
}

const digest = /^[a-f\d]{64}$/
const planLifetime = 20 * 60 * 1000

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function getStage(stage) {
  if (!Object.hasOwn(stages, stage)) throw problem('Unknown pipeline stage.')
  return stages[stage]
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined) return fallback
  const number = /^\d+$/.test(String(value)) ? Number(value) : NaN
  if (!Number.isSafeInteger(number) || number < min || number > max) throw problem('Invalid pagination.')
  return number
}

async function listInputs({ patient, stage, offset, limit }) {
  const specification = getStage(stage)
  const start = boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const count = boundedInteger(limit, 25, 1, 100)
  const root = await getDataRoot()
  const directory = await patientDirectory(root, patient)
  const inputs = []
  const references = []
  const seen = new Set()
  for await (const artifact of stageInputs(root, directory)) {
    if (seen.has(artifact.artifactId)) continue
    seen.add(artifact.artifactId)
    if (artifact.kind === specification.input) inputs.push(describeArtifact(artifact))
    if (specification.reference && artifact.kind === 'reference') references.push(describeArtifact(artifact))
  }
  const items = inputs.slice(start, start + count)
  const next = start + items.length
  return { patient, stage, inputKind: specification.input, referenceRequired: Boolean(specification.reference), references, items, total: inputs.length, nextOffset: items.length && next < inputs.length ? next : null }
}

function outputFiles(stage, inputs) {
  if (stage === 'fastqc') {
    const reports = inputs.map(({ file }) => `quality_control/${path.basename(file).replace(/\.(?:fastq|fq)(?:\.gz)?$/i, '')}_fastqc`)
    if (new Set(reports).size !== reports.length) throw problem('Choose FASTQ files with distinct FastQC report names.')
    return { required: reports.map((name) => `${name}.html`), optional: reports.map((name) => `${name}.zip`) }
  }
  const required = {
    bbduk: [`trimming/cleaned_${path.basename(inputs[0].file)}`],
    alignment: ['alignment/aligned_sorted.bam'],
    'mark-duplicates': ['post_alignment/dedup.bam', 'post_alignment/dup_metrics.txt'],
    'read-groups': ['variant_calling/dedup_rg.bam'],
    'index-bam': ['indexed.bam', 'indexed.bam.bai'],
    'prepare-reference': ['reference/reference.fa', 'reference/reference.fa.fai', 'reference/reference.dict', ...['amb', 'ann', 'bwt', 'pac', 'sa'].map((extension) => `reference/reference.fa.${extension}`)],
    'haplotype-caller': ['variant_calling/variants.vcf.gz'],
    vep: ['variant_annotation/annotated_variants.vcf'],
    'civic-report': [`ngs-report/${path.basename(inputs[0].file).replace(/\.vcf$/i, '')}_report.html`],
  }
  const optionalOutputs = stage === 'haplotype-caller' ? ['variant_calling/variants.vcf.gz.tbi'] : []
  return { required: required[stage], optional: optionalOutputs }
}

async function hasFile(file) {
  return Boolean((await optional(() => stat(file)))?.isFile())
}

async function checkPrerequisites(stage, inputs, reference) {
  if (stage === 'haplotype-caller') {
    const bam = inputs[0].file
    if (!await hasFile(`${bam}.bai`) && !await hasFile(bam.replace(/\.bam$/i, '.bai')) && !await hasFile(`${bam}.csi`)) {
      throw problem('The selected BAM has no index. Run index-bam and select its BAM output.')
    }
  }
  if (!reference) return
  if (stage === 'alignment') {
    for (const extension of ['amb', 'ann', 'bwt', 'pac', 'sa']) {
      if (!await hasFile(`${reference.file}.${extension}`)) throw problem('The selected reference is missing its BWA indexes. Prepare it in the alignment panel.')
    }
  } else {
    if (!await hasFile(`${reference.file}.fai`)) throw problem('The selected reference is missing its FASTA index (.fai).')
    const dictionary = reference.file.replace(/\.(?:fa|fasta|fna)$/i, '.dict')
    if (stage === 'haplotype-caller' && !await hasFile(dictionary) && !await hasFile(`${reference.file}.dict`)) {
      throw problem('The selected reference is missing its GATK sequence dictionary (.dict).')
    }
  }
}

function stageRequest(plan, directory, commandPath) {
  const { stage, inputs, reference, parameters, outputs } = plan
  const file = inputs[0].file
  const output = path.join(directory, outputs.required[0])
  const common = { patientDir: directory, parameters }
  switch (stage) {
    case 'fastqc': return { ...common, inputPaths: inputs.map((input) => input.file) }
    case 'bbduk': return { ...common, inputPath: file }
    case 'alignment': return { ...common, fastqPath: commandPath(file), refPath: commandPath(reference.file) }
    case 'mark-duplicates':
    case 'read-groups': return { ...common, inputBam: commandPath(file) }
    case 'index-bam': return { bamPath: commandPath(output) }
    case 'prepare-reference': return { refPath: commandPath(output) }
    case 'haplotype-caller': return { ...common, inputBam: commandPath(file), refPath: commandPath(reference.file), outputVcf: commandPath(output) }
    case 'vep': return { ...common, inputVcf: commandPath(file), fastaPath: commandPath(reference.file), outputVcf: commandPath(output) }
    case 'civic-report': return { ...common, inputVcf: file, outputHtml: output }
  }
}

function callStage(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (response) => {
      let text = ''
      response.on('error', reject)
      response.setEncoding('utf8').on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        try {
          const result = JSON.parse(text)
          if (response.statusCode >= 400 || !result || result.ok === false) {
            reject(new Error([result?.error, result?.detail].filter(Boolean).join(' — ') || 'The stage handler failed.'))
            return
          }
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function saveRun(directory, run) {
  const temporary = path.join(directory, 'run.tmp')
  await writeFile(temporary, JSON.stringify(run), { mode: 0o600 })
  await rename(temporary, path.join(directory, 'run.json'))
}

export function createStageRunner({ invokeStage, commandPath = (file) => file }) {
  const plans = new Map()
  const active = new Set()

  async function plan({ patient, stage, inputIds, referenceId, parameters }) {
    const spec = getStage(stage)
    const maximum = stage === 'fastqc' ? 16 : 1
    if (!Array.isArray(inputIds) || !inputIds.length || inputIds.length > maximum || new Set(inputIds).size !== inputIds.length || !inputIds.every((id) => typeof id === 'string' && digest.test(id))) {
      throw problem(maximum === 1 ? 'Select one input artifact.' : 'Select one to sixteen distinct FASTQ artifacts.')
    }
    if (spec.reference ? typeof referenceId !== 'string' || !digest.test(referenceId) : referenceId !== undefined) {
      throw problem(spec.reference ? 'Select a reference artifact for this stage.' : 'This stage uses only the selected input artifacts.')
    }
    const preparation = stage === 'index-bam' || stage === 'prepare-reference'
    if (preparation && parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).length)) {
      throw problem('This preparation stage uses the selected input without parameter overrides.')
    }
    const settings = preparation ? { parameters: {}, args: {} } : resolveStageParameters(stage, parameters)
    const root = await getDataRoot()
    const patientDir = await patientDirectory(root, patient)
    const wanted = new Set([...inputIds, referenceId].filter(Boolean))
    const matches = new Map()
    for await (const artifact of stageInputs(root, patientDir)) {
      if (!wanted.has(artifact.artifactId)) continue
      matches.set(artifact.artifactId, artifact)
      if (matches.size === wanted.size) break
    }
    const inputs = inputIds.map((id) => matches.get(id))
    if (inputs.some((item) => item?.kind !== spec.input)) throw problem(`Select current ${spec.input} artifacts from list_stage_inputs.`)
    const reference = referenceId ? matches.get(referenceId) : null
    if (spec.reference && reference?.kind !== 'reference') throw problem('The reference artifact is unavailable.')
    if (stage === 'bbduk' && ![root, inputs[0].file].every((file) => /^[A-Za-z0-9._/\\:-]+$/.test(file))) {
      throw problem('BBDuk requires an input and results path with shell-safe filenames and no spaces.')
    }
    await checkPrerequisites(stage, inputs, reference)
    const runId = randomUUID()
    const outputs = outputFiles(stage, inputs)
    const expires = Date.now() + planLifetime
    const pending = { root, patient, patientDir, stage, inputs, reference, outputs, expires, parameters: settings.parameters }
    const expectedOutputs = await previewPatientOutputs(pending, runId)
    for (const [id, stored] of plans) {
      if (stored.expires <= Date.now()) plans.delete(id)
    }
    if (plans.size >= 128) throw problem('Too many active run previews. Wait for a preview to expire.', 429)
    plans.set(runId, pending)
    return {
      planId: runId,
      patient,
      stage,
      inputs: inputs.map(describeArtifact),
      ...(reference && { reference: describeArtifact(reference) }),
      ...settings,
      expectedOutputs,
      expiresAt: new Date(expires).toISOString(),
    }
  }

  async function status({ runId }) {
    if (typeof runId !== 'string' || !runIdPattern.test(runId)) throw problem('Invalid run ID.')
    const root = await getDataRoot()
    const run = await readStageRun(root, runId)
    if (!run) throw problem('Stage run not found.', 404)
    const state = run.status === 'running' && !active.has(runId) ? 'interrupted' : run.status
    const outputs = (await stageRunOutputs(root, run)).map(describeArtifact)
    return { ...run, status: state, outputs }
  }

  async function execute(plan, runId, directory, run) {
    try {
      for (const output of plan.outputs.required) await mkdir(path.dirname(path.join(directory, output)), { recursive: true })
      if (plan.stage === 'index-bam') {
        await copyFile(plan.inputs[0].file, path.join(directory, 'indexed.bam'), constants.COPYFILE_FICLONE)
      }
      if (plan.stage === 'prepare-reference') {
        await copyFile(plan.inputs[0].file, path.join(directory, plan.outputs.required[0]), constants.COPYFILE_FICLONE)
        await invokeStage('/api/alignment/index-ref', stageRequest(plan, directory, commandPath))
      }
      await invokeStage(getStage(plan.stage).endpoint, stageRequest(plan, directory, commandPath))
      const checked = []
      for (const output of [...plan.outputs.required, ...plan.outputs.optional]) {
        if (await stageArtifact(path.join(directory, output), output, directory)) checked.push(output)
        else if (plan.outputs.required.includes(output)) throw new Error(`The stage did not produce ${output}.`)
      }
      const published = await publishPatientOutputs(plan, runId, directory, checked)
      await saveRun(directory, { ...run, status: 'succeeded', finishedAt: new Date().toISOString(), outputs: checked, published })
    } catch (error) {
      await saveRun(directory, { ...run, status: 'failed', finishedAt: new Date().toISOString(), error: error.message.slice(0, 2000) })
    } finally {
      active.delete(runId)
      plans.delete(runId)
    }
  }

  async function begin(plan, runId) {
    if (await getDataRoot() !== plan.root) throw problem('The configured results folder changed. Create a fresh preview.')
    await patientDirectory(plan.root, plan.patient)
    for (const item of [...plan.inputs, plan.reference].filter(Boolean)) {
      if ((await stageArtifact(item.file, item.label))?.artifactId !== item.artifactId) {
        throw problem('An input changed after the preview. Select the current artifact and make a new preview.')
      }
    }
    await checkPrerequisites(plan.stage, plan.inputs, plan.reference)
    const parent = path.join(plan.root, runsFolder)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if (await realpath(parent) !== parent) throw problem('The stage runs folder must be inside the configured data root.')
    const directory = path.join(parent, runId)
    await mkdir(directory, { mode: 0o700 })
    const run = { runId, patient: plan.patient, stage: plan.stage, status: 'running', startedAt: new Date().toISOString(), outputs: [] }
    active.add(runId)
    try {
      await saveRun(directory, run)
    } catch (error) {
      active.delete(runId)
      throw error
    }
    void execute(plan, runId, directory, run).catch((error) => console.error('Unable to save stage run state:', error.code ?? error.message))
    return run
  }

  async function start({ planId }) {
    if (typeof planId !== 'string' || !runIdPattern.test(planId)) throw problem('Invalid plan ID.')
    const plan = plans.get(planId)
    if (plan?.launch) return plan.launch
    if (!plan || plan.expires <= Date.now()) {
      const root = await getDataRoot()
      if (await readStageRun(root, planId)) return status({ runId: planId })
      throw problem('The run preview expired or is unavailable. Create a new preview.', 404)
    }
    plan.launch = begin(plan, planId).catch((error) => {
      plans.delete(planId)
      throw error
    })
    return plan.launch
  }

  return { listInputs, plan, start, status }
}

export function registerStageRunRoutes(app, { port, commandPath }) {
  const runner = createStageRunner({ invokeStage: (endpoint, body) => callStage(port, endpoint, body), commandPath })
  const route = (method) => async (req, res) => {
    const sameHost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    if (!sameHost || req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) {
      return res.status(403).json({ error: 'Stage run requests must come from the local MCP client.' })
    }
    try {
      res.json(await method(req.method === 'GET' ? req.query : req.body ?? {}))
    } catch (error) {
      res.status(error.status ?? (error.code ? 500 : 400)).json({ error: error.code ? 'Unable to access the stage run files.' : error.message })
    }
  }
  app.get('/api/stage-runs/inputs', route(runner.listInputs))
  app.post('/api/stage-runs/plan', route(runner.plan))
  app.post('/api/stage-runs/start', route(runner.start))
  app.get('/api/stage-runs/status', route(runner.status))
}
