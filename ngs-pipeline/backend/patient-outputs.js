import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, mkdir, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { isUnderDirectory } from './data-root.js'
import { optional, stageArtifact } from './stage-artifacts.js'

function outputLayout(plan, files) {
  if (plan.stage === 'index-bam') {
    const input = plan.inputs[0]
    const name = path.basename(input.file)
    const parent = path.dirname(input.file)
    const besideInput = parent === plan.patientDir || isUnderDirectory(plan.patientDir, parent)
    const directory = besideInput ? parent : path.join(plan.patientDir, 'alignment')
    const bam = { source: 'indexed.bam', name }
    const index = { source: 'indexed.bam.bai', name: `${name}.bai` }
    return { directory, version: [bam, index], canonical: besideInput ? [index] : [bam, index], original: besideInput ? input : null }
  }
  const subfolder = path.dirname(files[0])
  const directory = path.join(plan.patientDir, subfolder)
  const outputs = files.map((source) => ({ source, name: path.basename(source) }))
  return { directory, version: outputs, canonical: outputs, original: null }
}

function labelFor(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

async function outputDirectoriesAreSafe(patient, directory, create) {
  if (await realpath(patient) !== patient) throw new Error('The patient directory changed. Select the patient again.')
  const relative = path.relative(patient, directory)
  if (directory !== patient && !isUnderDirectory(patient, directory)) throw new Error('Invalid patient output directory.')
  let current = patient
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (create) await mkdir(current, { recursive: true })
    const info = await optional(() => lstat(current))
    if (!info) return
    if (!info.isDirectory() || await realpath(current) !== current) throw new Error('The patient output directory must be a regular directory.')
  }
}

async function needsVersion(directory, targets) {
  for (const { name } of targets) {
    if (await optional(() => lstat(path.join(directory, name)))) return true
  }
  return false
}

function existingNamesToCheck(plan, canonical) {
  const known = [...canonical, ...plan.outputs.optional.map((source) => ({ name: path.basename(source) }))]
  const bam = plan.stage === 'index-bam' ? path.basename(plan.inputs[0].file) : null
  const bamNames = bam ? [bam] : canonical.map(({ name }) => name).filter((name) => /\.bam$/i.test(name))
  for (const name of bamNames) {
    known.push({ name: `${name}.bai` }, { name: name.replace(/\.bam$/i, '.bai') }, { name: `${name}.csi` })
  }
  return known
}

export async function previewPatientOutputs(plan, runId) {
  const { directory, canonical, version } = outputLayout(plan, plan.outputs.required)
  await outputDirectoriesAreSafe(plan.patientDir, directory, false)
  const versioned = await needsVersion(directory, existingNamesToCheck(plan, canonical))
  const destination = versioned ? path.join(directory, 'runs', runId) : directory
  if (versioned) await outputDirectoriesAreSafe(plan.patientDir, destination, false)
  return (versioned ? version : canonical).map(({ name }) => labelFor(plan.root, path.join(destination, name)))
}

async function publishFile(source, destination) {
  const temporary = path.join(path.dirname(destination), `.publish-${randomUUID()}`)
  const flags = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
  await copyFile(source, temporary, flags)
  try {
    try {
      await link(temporary, destination)
    } catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes(error.code)) throw error
      await copyFile(temporary, destination, flags)
    }
  } finally {
    await unlink(temporary)
  }
}

async function copyOutputs(root, patient, archive, directory, targets) {
  const copies = []
  try {
    for (const { source, name } of targets) {
      const file = path.join(directory, name)
      const label = labelFor(root, file)
      await publishFile(path.join(archive, source), file)
      const artifact = await stageArtifact(file, label, patient)
      if (!artifact) throw new Error(`Unable to publish ${name} in the patient folder.`)
      copies.push({ file, label, artifactId: artifact.artifactId })
    }
  } catch (error) {
    for (const copy of copies) {
      if ((await stageArtifact(copy.file, copy.label, patient))?.artifactId === copy.artifactId) {
        await unlink(copy.file)
      }
    }
    throw error
  }
  return copies.map(({ label, artifactId }) => ({ label, artifactId }))
}

export async function publishPatientOutputs(plan, runId, archive, files) {
  const { root, patientDir } = plan
  const { directory, canonical, version, original } = outputLayout(plan, files)
  await outputDirectoriesAreSafe(patientDir, directory, true)
  if (original && (await stageArtifact(original.file, original.label, patientDir))?.artifactId !== original.artifactId) {
    throw new Error('The selected BAM changed. Run indexing again with the current BAM.')
  }

  if (!await needsVersion(directory, existingNamesToCheck(plan, canonical))) {
    try {
      const published = await copyOutputs(root, patientDir, archive, directory, canonical)
      return original ? [{ label: original.label, artifactId: original.artifactId }, ...published] : published
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }

  const versionDirectory = path.join(directory, 'runs', runId)
  await outputDirectoriesAreSafe(patientDir, versionDirectory, true)
  return copyOutputs(root, patientDir, archive, versionDirectory, version)
}
