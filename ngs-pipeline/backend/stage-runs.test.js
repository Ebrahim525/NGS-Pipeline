import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createStageRunner } from './stage-runs.js'
import { patientFolders } from './patient-folders.js'
import { listResults } from './vcf-results.js'

test('one reviewed stage runs independently and publishes only its own completed artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ngs-stage-runs-'))
  const previousRoot = process.env.NGS_RESULTS_ROOT
  process.env.NGS_RESULTS_ROOT = root
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.NGS_RESULTS_ROOT
    else process.env.NGS_RESULTS_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  })

  const rawVcf = '##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tdemo\n'
  const patient = 'Patient1'
  const patientDir = path.join(root, patient)
  const otherPatientDir = path.join(root, 'Patient2')
  await mkdir(patientDir)
  await mkdir(otherPatientDir)
  await writeFile(path.join(root, 'demo.vcf'), rawVcf)
  await writeFile(path.join(patientDir, 'existing.vcf'), rawVcf)
  await writeFile(path.join(root, 'source.fa'), '>chr1\nATCG\n')
  await writeFile(path.join(patientDir, 'reads.fastq'), '@demo\nATCG\n+\nIIII\n')
  await writeFile(path.join(patientDir, 'existing.bam'), 'demo BAM')
  await writeFile(path.join(otherPatientDir, 'other.fastq'), '@demo\nATCG\n+\nIIII\n')
  assert.deepEqual(await patientFolders(), [{ patient }, { patient: 'Patient2' }])

  const calls = []
  let finishVep
  const waitForVep = new Promise((resolve) => { finishVep = resolve })
  const runner = createStageRunner({
    invokeStage: async (endpoint, body) => {
      calls.push({ endpoint, body })
      if (endpoint === '/api/alignment/index-ref') {
        for (const extension of ['amb', 'ann', 'bwt', 'pac', 'sa']) await writeFile(`${body.refPath}.${extension}`, 'demo index')
        return
      }
      if (endpoint === '/api/variant-calling/prepare-reference') {
        await writeFile(`${body.refPath}.fai`, 'demo FASTA index')
        await writeFile(body.refPath.replace(/\.fa$/, '.dict'), 'demo dictionary')
        return
      }
      if (endpoint === '/api/alignment/index-bam') {
        await writeFile(`${body.bamPath}.bai`, 'demo BAM index')
        return
      }
      if (endpoint === '/api/variant-annotation/run') {
        await waitForVep
        if (body.parameters.fork === 1) throw new Error('Simulated VEP failure')
        const vepVcf = rawVcf.replace('#CHROM', '##INFO=<ID=CSQ,Number=.,Type=String,Description="Format: Allele|Consequence|SYMBOL">\n#CHROM')
        await writeFile(body.outputVcf, vepVcf)
      }
    },
  })

  const terminal = async (runId) => {
    for (let checks = 0; checks < 50; checks++) {
      const run = await runner.status({ runId })
      if (run.status !== 'running') return run
      await delay(10)
    }
    assert.fail('The stage did not finish.')
  }

  const { items: [reference] } = await runner.listInputs({ patient, stage: 'prepare-reference' })
  const prepare = await runner.plan({ patient, stage: 'prepare-reference', inputIds: [reference.artifactId] })
  assert.equal(calls.length, 0)
  await runner.start(prepare)
  const prepared = await terminal(prepare.planId)
  assert.equal(prepared.status, 'succeeded')
  assert.equal(prepared.outputs.length, 8)
  assert.equal(prepared.outputs[0].label, 'Patient1/reference/reference.fa')
  assert.deepEqual(calls.map(({ endpoint }) => endpoint), ['/api/alignment/index-ref', '/api/variant-calling/prepare-reference'])

  const { items: [vcf] } = await runner.listInputs({ patient, stage: 'vep' })
  const preparedReference = prepared.outputs.find(({ kind }) => kind === 'reference')
  const vepPlan = await runner.plan({
    patient, stage: 'vep',
    inputIds: [vcf.artifactId],
    referenceId: preparedReference.artifactId,
    parameters: { fork: 6, alleleNumber: true },
  })
  assert.deepEqual(vepPlan.args.main, ['--fork', '6', '--allele_number'])
  assert.deepEqual(vepPlan.expectedOutputs, ['Patient1/variant_annotation/annotated_variants.vcf'])
  const [first, retry] = await Promise.all([runner.start(vepPlan), runner.start(vepPlan)])
  assert.equal(first.runId, retry.runId)
  assert.equal((await runner.status(first)).status, 'running')
  assert.equal((await listResults()).total, 1)
  finishVep()
  const annotated = await terminal(first.runId)
  assert.equal(annotated.status, 'succeeded')
  assert.equal(annotated.outputs[0].label, 'Patient1/variant_annotation/annotated_variants.vcf')
  assert.equal(calls.filter(({ endpoint }) => endpoint === '/api/variant-annotation/run').length, 1)
  assert.equal((await listResults()).total, 2)
  assert.equal(await readFile(path.join(patientDir, 'existing.vcf'), 'utf8'), rawVcf)
  const originalAnnotation = await readFile(path.join(root, annotated.outputs[0].label), 'utf8')

  const rerun = await runner.plan({
    patient, stage: 'vep', inputIds: [vcf.artifactId], referenceId: preparedReference.artifactId, parameters: { fork: 2 },
  })
  const versioned = `Patient1/variant_annotation/runs/${rerun.planId}/annotated_variants.vcf`
  assert.deepEqual(rerun.expectedOutputs, [versioned])
  await runner.start(rerun)
  assert.equal((await terminal(rerun.planId)).outputs[0].label, versioned)
  assert.equal(await readFile(path.join(root, annotated.outputs[0].label), 'utf8'), originalAnnotation)
  assert.equal((await listResults({ patient })).total, 2)
  assert.equal((await listResults({ patient: 'Patient2' })).total, 0)

  const failedPlan = await runner.plan({
    patient, stage: 'vep', inputIds: [vcf.artifactId], referenceId: preparedReference.artifactId, parameters: { fork: 1 },
  })
  await runner.start(failedPlan)
  const failed = await terminal(failedPlan.planId)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.outputs, [])
  assert.equal((await listResults()).total, 3)

  const bam = (await runner.listInputs({ patient, stage: 'index-bam' })).items[0]
  await assert.rejects(runner.plan({
    patient, stage: 'haplotype-caller', inputIds: [bam.artifactId], referenceId: preparedReference.artifactId,
  }), /no index/)
  const indexPlan = await runner.plan({ patient, stage: 'index-bam', inputIds: [bam.artifactId] })
  await runner.start(indexPlan)
  const indexed = await terminal(indexPlan.planId)
  assert.deepEqual(indexed.outputs.map(({ kind }) => kind), ['bam', 'index'])
  assert.equal(indexed.outputs[0].artifactId, bam.artifactId)
  assert.equal(indexed.outputs[1].label, 'Patient1/existing.bam.bai')
  const called = await runner.plan({
    patient, stage: 'haplotype-caller',
    inputIds: [indexed.outputs[0].artifactId],
    referenceId: preparedReference.artifactId,
  })
  assert.equal(called.stage, 'haplotype-caller')

  const { items: [reads], total } = await runner.listInputs({ patient, stage: 'fastqc' })
  assert.equal(total, 1)
  await assert.rejects(runner.plan({ patient: 'Patient2', stage: 'fastqc', inputIds: [reads.artifactId] }), /current fastq/)
  await assert.rejects(runner.listInputs({ patient: '../Patient1', stage: 'fastqc' }), /Select a patient/)
  const qc = await runner.plan({ patient, stage: 'fastqc', inputIds: [reads.artifactId] })
  await writeFile(path.join(patientDir, 'reads.fastq'), '@updated\nATCG\n+\nIIII\n')
  await assert.rejects(runner.start(qc), /changed after the preview/)
  assert.equal(calls.some(({ endpoint }) => endpoint === '/api/qc/run'), false)
})
