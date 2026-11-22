import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveStageParameters } from './stageParameters.js'

test('maps settings to the arguments for their own command', () => {
  assert.deepEqual(resolveStageParameters('fastqc', { threads: 3 }).args, {
    main: ['-Dfastqc.threads=3'],
  })
  assert.deepEqual(resolveStageParameters('bbduk', { trimq: 25, hdist: 0 }).args.main, [
    'k=23', 'mink=11', 'hdist=0', 'trimq=25', 'minlen=30',
  ])
  assert.deepEqual(resolveStageParameters('alignment', { bwaThreads: 5, sortThreads: 2 }).args, {
    bwa: ['-t', '5'],
    sort: ['-@', '2'],
  })
  assert.deepEqual(resolveStageParameters('mark-duplicates').args.main, [])
  assert.deepEqual(resolveStageParameters('mark-duplicates', { removeDuplicates: true }).args.main, [
    'REMOVE_DUPLICATES=true',
  ])
  assert.deepEqual(resolveStageParameters('read-groups', { rgsm: 'demo_02' }).args.main, [
    'RGID=1', 'RGLB=lib1', 'RGPL=ILLUMINA', 'RGPU=unit1', 'RGSM=demo_02',
  ])
  assert.deepEqual(resolveStageParameters('haplotype-caller', { interval: 'chr1:10-40', pairHmmThreads: 2 }).args.main, [
    '--native-pair-hmm-threads', '2', '-L', 'chr1:10-40',
  ])
  assert.deepEqual(resolveStageParameters('vep', { fork: '2', alleleNumber: true }).args.main, [
    '--fork', '2', '--allele_number',
  ])
  assert.deepEqual(resolveStageParameters('civic-report', { afThreshold: '0.005', refreshEvidence: true }).args.main, [
    '--af-threshold', '0.005', '--no-cache',
  ])
})

test('rejects invalid values and options from other stages', () => {
  assert.throws(() => resolveStageParameters('bbduk', { k: 10, mink: 11 }), /must be at most/)
  assert.throws(() => resolveStageParameters('alignment', { sortThreads: 1.5 }), /whole number/)
  assert.throws(() => resolveStageParameters('fastqc', { threads: '' }), /required/)
  assert.throws(() => resolveStageParameters('mark-duplicates', { removeDuplicates: 'false' }), /true or false/)
  assert.throws(() => resolveStageParameters('vep', { threads: 2 }), /Unknown parameter/)
  assert.throws(() => resolveStageParameters('read-groups', { rgsm: 'two words' }), /invalid format/)
  assert.throws(() => resolveStageParameters('haplotype-caller', { interval: 'chr1:40-10' }), /ascending order/)
  assert.throws(() => resolveStageParameters('civic-report', { afThreshold: 1.01 }), /0 to 1/)
  assert.throws(() => resolveStageParameters('constructor'), /Unknown pipeline stage/)
  assert.throws(() => resolveStageParameters('vep', null), /must be an object/)
})
