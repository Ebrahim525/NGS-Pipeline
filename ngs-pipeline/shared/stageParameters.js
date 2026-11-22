const readGroup = { type: 'token', pattern: '^[A-Za-z0-9._-]{1,128}$' }

export const STAGE_PARAMETERS = {
  fastqc: {
    threads: { label: 'Parallel files', type: 'integer', min: 1, max: 16, default: 1, flag: '-Dfastqc.threads=', help: 'FastQC processes up to this many input files at once.' },
  },
  bbduk: {
    k: { label: 'Adapter k-mer length', type: 'integer', min: 1, max: 31, default: 23, flag: 'k=' },
    mink: { label: 'Minimum end k-mer length', type: 'integer', min: 1, max: 31, default: 11, flag: 'mink=' },
    hdist: { label: 'Allowed k-mer mismatches', type: 'integer', min: 0, max: 3, default: 1, flag: 'hdist=' },
    trimq: { label: 'Quality trimming threshold', type: 'integer', min: 0, max: 60, default: 20, flag: 'trimq=' },
    minlen: { label: 'Minimum retained read length', type: 'integer', min: 1, max: 999, default: 30, flag: 'minlen=' },
  },
  alignment: {
    bwaThreads: { label: 'BWA-MEM threads', type: 'integer', min: 1, max: 32, default: 1, flag: '-t', group: 'bwa' },
    sortThreads: { label: 'Extra SAMtools sort threads', type: 'integer', min: 0, max: 32, default: 0, flag: '-@', group: 'sort' },
  },
  'mark-duplicates': {
    removeDuplicates: { label: 'Remove duplicate reads from the output BAM', type: 'boolean', default: false, flag: 'REMOVE_DUPLICATES=true', help: 'Leave unchecked to flag duplicate reads and retain them in the BAM.' },
  },
  'read-groups': {
    rgid: { ...readGroup, label: 'Read group ID', default: '1', flag: 'RGID=' },
    rglb: { ...readGroup, label: 'Library', default: 'lib1', flag: 'RGLB=' },
    rgpl: { ...readGroup, label: 'Sequencing platform', default: 'ILLUMINA', flag: 'RGPL=' },
    rgpu: { ...readGroup, label: 'Platform unit', default: 'unit1', flag: 'RGPU=' },
    rgsm: { ...readGroup, label: 'Sample name', default: 'sample1', flag: 'RGSM=' },
  },
  'haplotype-caller': {
    pairHmmThreads: { label: 'Native PairHMM threads', type: 'integer', min: 1, max: 32, flag: '--native-pair-hmm-threads', help: 'Blank uses the installed GATK default.' },
    interval: { label: 'Calling interval', type: 'token', pattern: '^[A-Za-z0-9_]+(?::[1-9][0-9]*-[1-9][0-9]*)?$', maxLength: 128, flag: '-L', help: 'Use a reference contig or a range such as chr1:1000-2000. Blank uses the full reference.' },
  },
  vep: {
    fork: { label: 'Parallel forks', type: 'integer', min: 1, max: 16, default: 4, flag: '--fork' },
    alleleNumber: { label: 'Include the alternate allele index (ALLELE_NUM)', type: 'boolean', default: false, flag: '--allele_number', help: 'Helps match annotations to individual alternate alleles.' },
  },
  'civic-report': {
    afThreshold: { label: 'Report allele frequency threshold (fraction)', type: 'number', min: 0, max: 1, flag: '--af-threshold', help: 'Applies to the legacy report table. For example, 0.005 means 0.5%. Blank uses the report default.' },
    refreshEvidence: { label: 'Refresh evidence from external sources', type: 'boolean', default: false, flag: '--no-cache' },
  },
}

export function resolveStageParameters(stage, overrides = {}) {
  if (!Object.hasOwn(STAGE_PARAMETERS, stage)) throw new Error('Unknown pipeline stage.')
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Parameters must be an object.')
  }

  const fields = STAGE_PARAMETERS[stage]
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(fields, key)) throw new Error(`Unknown parameter: ${key}.`)
  }

  const parameters = {}
  const args = {}
  for (const [key, field] of Object.entries(fields)) {
    const value = readParameter(field, Object.hasOwn(overrides, key) ? overrides[key] : field.default)
    if (value === undefined) continue

    parameters[key] = value
    const group = args[field.group ?? 'main'] ??= []
    if (field.type === 'boolean') {
      if (value) group.push(field.flag)
    } else if (field.flag.endsWith('=')) {
      group.push(field.flag + value)
    } else {
      group.push(field.flag, String(value))
    }
  }

  if (stage === 'bbduk' && parameters.mink > parameters.k) {
    throw new Error('Minimum end k-mer length must be at most the adapter k-mer length.')
  }
  if (stage === 'haplotype-caller' && parameters.interval?.includes(':')) {
    const [start, end] = parameters.interval.split(':')[1].split('-').map(Number)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      throw new Error('Calling interval coordinates must be valid integers in ascending order.')
    }
  }

  return { parameters, args }
}

function readParameter(field, value) {
  if (value === undefined || value === '') {
    if (field.default === undefined) return undefined
    throw new Error(`${field.label} is required.`)
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${field.label} must be true or false.`)
    return value
  }
  if (field.type === 'token') {
    if (typeof value !== 'string' || value.length > (field.maxLength ?? 128) || !new RegExp(field.pattern).test(value)) {
      throw new Error(`${field.label} has an invalid format.`)
    }
    return value
  }
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))
    ? Number(value)
    : NaN
  if (!Number.isFinite(numeric) || (field.type === 'integer' && !Number.isInteger(numeric)) || numeric < field.min || numeric > field.max) {
    throw new Error(`${field.label} must be ${field.type === 'integer' ? 'a whole number' : 'a number'} from ${field.min} to ${field.max}.`)
  }
  return numeric
}
