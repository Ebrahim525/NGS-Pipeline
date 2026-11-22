import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import { resolveStageParameters, STAGE_PARAMETERS } from '../shared/stageParameters.js'
import { getClinicalEvidence } from './civic-evidence.js'
import { getVariant, listGenes, listResults, listVariants } from './vcf-results.js'
import { createPatientFolder, patientFolders } from './patient-folders.js'

const stageSchema = z.enum(Object.keys(STAGE_PARAMETERS))
const parameterValue = z.union([z.string(), z.number(), z.boolean()])
const parameterValues = z.record(z.string(), parameterValue)
const readOnly = { readOnlyHint: true, openWorldHint: false }
const pagination = {
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Continue from nextOffset in the previous response.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum entries to return. Defaults to 20.'),
}
const selection = {
  resultId: z.string().regex(/^[a-f\d]{64}$/).describe('Exact result ID from list_results. Reuse it on follow-up questions.'),
  sample: z.string().min(1).max(512).optional().describe('Exact sample name from list_results. Required for multi-sample VCFs.'),
}
const filter = z.enum(['pass_or_unfiltered', 'pass', 'unfiltered', 'filtered', 'all']).optional()
  .describe('Defaults to pass_or_unfiltered. Unfiltered calls have VCF FILTER=.; their filter status is included in the output.')
const variantId = z.string().regex(/^[1-9]\d{0,14}:[1-9]\d{0,8}$/).describe('Exact variant ID from list_variants in the same result and sample.')
const executionStage = z.enum([...Object.keys(STAGE_PARAMETERS), 'index-bam', 'prepare-reference'])
const runId = z.uuid()
const artifactId = z.string().regex(/^[a-f\d]{64}$/)
const patientName = z.string().min(1).max(255).describe('Exact patient folder name from list_patients.')

function toolResult(data) {
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function registerTool(server, name, description, shape, handler, annotations = readOnly) {
  server.registerTool(name, {
    description,
    inputSchema: z.strictObject(shape),
    outputSchema: z.record(z.string(), z.unknown()),
    annotations,
  }, async (input) => {
    try {
      return toolResult(await handler(input))
    } catch (error) {
      const message = error.code ? 'Unable to read the configured result artifact.' : error.message
      return { isError: true, content: [{ type: 'text', text: message }] }
    }
  })
}

async function stageRunApi(route, input, method = 'GET') {
  const port = Number(process.env.NGS_PIPELINE_PORT ?? process.env.PORT ?? '8787')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set NGS_PIPELINE_PORT to the local pipeline API port.')
  const url = new URL(`http://127.0.0.1:${port}/api/stage-runs/${route}`)
  if (method === 'GET') {
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
  }
  const options = method === 'GET' ? {} : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }
  let response
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) })
  } catch {
    throw new Error(`The local pipeline API is unavailable on port ${port}. Start the backend and check NGS_PIPELINE_PORT.`)
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'The stage run request failed.')
  return payload
}

serveStdio(() => {
  const server = new McpServer({ name: 'ngs-pipeline', version: '0.1.0' })

  server.registerTool(
    'list_stage_parameters',
    {
      description: 'List supported NGS pipeline parameters, defaults, and validation rules. Omit the stage to list all stages.',
      inputSchema: z.strictObject({ stage: stageSchema.optional() }),
      outputSchema: z.object({
        stages: z.record(z.string(), z.record(z.string(), parameterValues)),
      }),
      annotations: readOnly,
    },
    async ({ stage }) => toolResult({
      stages: stage ? { [stage]: STAGE_PARAMETERS[stage] } : STAGE_PARAMETERS,
    }),
  )

  server.registerTool(
    'preview_stage_parameters',
    {
      description: 'Validate proposed settings and preview the arguments for each command in the selected NGS stage. Use list_stage_parameters to discover valid parameter names. This tool only generates a preview.',
      inputSchema: z.strictObject({
        stage: stageSchema,
        parameters: parameterValues.optional().describe('Parameter overrides keyed by name. Omitted values use the stage defaults.'),
      }),
      outputSchema: z.object({
        stage: stageSchema,
        parameters: parameterValues,
        args: z.record(z.string(), z.array(z.string())),
      }),
      annotations: readOnly,
    },
    async ({ stage, parameters }) => {
      try {
        return toolResult({ stage, ...resolveStageParameters(stage, parameters) })
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] }
      }
    },
  )

  registerTool(server, 'list_results',
    'List available VCF results, their samples, and whether the VEP annotation header is present. Select a patient to limit results to that folder.',
    { ...pagination, patient: patientName.optional() }, listResults)

  registerTool(server, 'list_variants',
    'List called alternate alleles for the selected sample. Filter by gene, annotation availability, or filter status. Use the returned variant ID for allele frequency and annotation follow-ups.',
    {
      ...selection,
      ...pagination,
      filter,
      gene: z.string().trim().min(1).max(128).optional(),
      annotated: z.boolean().optional().describe('True selects alleles with matched VEP annotations. False selects alleles without them.'),
    }, listVariants)

  registerTool(server, 'list_genes',
    'List genes with called variants in the selected sample and count the alternate alleles annotated to each gene.',
    { ...selection, ...pagination, filter }, listGenes)

  registerTool(server, 'get_variant',
    'Explain one called allele using its VEP annotations and source record. Sample read fraction from FORMAT/AD, any sample FORMAT/AF, and site INFO/AF are separate fields. Pagination applies to the transcript annotations.',
    { ...selection, variantId, ...pagination }, getVariant)

  registerTool(server, 'get_clinical_evidence',
    'Look up accepted CIViC evidence for exact alleles in the selected sample and a specific disease. Use an exact CIViC disease name or DOID, and supply variantId to narrow the lookup to one allele. Results describe curated evidence and include the evidence type, direction, and source.',
    {
      ...selection,
      ...pagination,
      filter,
      variantId: variantId.optional(),
      disease: z.string().trim().max(200).optional().describe('Disease context supplied by the user, as an exact CIViC name or a DOID.'),
    }, getClinicalEvidence)

  registerTool(server, 'list_patients',
    'List the same patient folders used by the pipeline frontend. Use the exact patient folder name when listing inputs or planning a stage run.',
    {}, async () => ({ items: await patientFolders() }))

  registerTool(server, 'create_patient',
    'Create a patient folder in the configured NGS data root when the user provides a folder name. Spaces become underscores. Returns the exact patient name to use in stage runs.',
    { name: z.string().trim().min(1).max(255) }, ({ name }) => createPatientFolder(name),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false })

  registerTool(server, 'list_stage_inputs',
    'List compatible input artifacts in the selected patient folder and shared reference choices. Use one selected artifact per run, or up to sixteen FASTQs for FastQC.',
    { patient: patientName, stage: executionStage, ...pagination }, (input) => stageRunApi('inputs', input))

  registerTool(server, 'plan_stage_run',
    'Validate the patient, artifacts and parameters for one independent stage. Returns a plan ID, resolved arguments and expected patient output paths. Use list_patients and list_stage_inputs first.',
    {
      patient: patientName,
      stage: executionStage,
      inputIds: z.array(artifactId).min(1).max(16),
      referenceId: artifactId.optional(),
      parameters: parameterValues.optional(),
    }, (input) => stageRunApi('plan', input, 'POST'), { readOnlyHint: false, destructiveHint: false, openWorldHint: false })

  registerTool(server, 'start_stage_run',
    'Start exactly one stage using the reviewed plan ID. Call only after the user asks to run that stage with those inputs and settings. Returns a run ID immediately. Use get_run_status to check completion.',
    { planId: runId }, (input) => stageRunApi('start', input, 'POST'),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true })

  registerTool(server, 'get_run_status',
    'Return the state of a stage run, any error, and completed output artifacts. Use those artifacts as inputs to a separate stage if the user asks to run it.',
    { runId }, (input) => stageRunApi('status', input))

  return server
})
