import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { getDataRoot } from './data-root.js'

function validName(patient) {
  return typeof patient === 'string' && patient.length > 0 && !patient.startsWith('.')
    && patient !== 'node_modules' && !/[\\/:*?"<>|\r\n\0]/.test(patient)
}

export function sanitizeFolderName(name) {
  const value = String(name ?? '').trim()
  if (!value) throw Object.assign(new Error('Folder name is required'), { status: 400 })
  if (value === '.' || value === '..' || /[\\/:*?"<>|\r\n\0]/.test(value)) {
    throw Object.assign(new Error('Folder name must not contain path separators or : * ? " < > |'), { status: 400 })
  }
  // BBTools shell wrappers require folder names without whitespace.
  return value.replace(/\s+/g, '_')
}

export async function createPatientFolder(name) {
  const requested = sanitizeFolderName(name)
  if (!validName(requested)) throw new Error('Choose a visible patient name in the NGS data folder.')
  const root = await getDataRoot()
  const target = path.join(root, requested)
  let created = true
  try {
    await mkdir(target)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!(await lstat(target)).isDirectory()) throw new Error('That name is already in use by a file or link.')
    created = false
  }
  const directory = await realpath(target)
  if (path.dirname(directory) !== root) throw new Error('The patient folder must be inside the NGS data root.')
  return { patient: path.basename(directory), created }
}

export async function patientFolders(root = undefined) {
  const directory = root ?? await getDataRoot()
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => validName(entry.name) && entry.isDirectory())
    .map(({ name }) => ({ patient: name }))
    .sort((a, b) => a.patient.localeCompare(b.patient))
}

export async function patientDirectory(root, patient) {
  if (!validName(patient)) throw new Error('Select a patient folder from list_patients.')
  const directory = path.join(root, patient)
  const entries = await readdir(root, { withFileTypes: true })
  if (!entries.some((entry) => entry.name === patient && entry.isDirectory()) || await realpath(directory) !== directory) {
    throw new Error('The selected patient folder is unavailable. Call list_patients again.')
  }
  return directory
}
