import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export function isUnderDirectory(directory, file) {
  const relative = path.relative(directory, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function getDataRoot() {
  let configured = process.env.NGS_RESULTS_ROOT
  if (!configured) {
    const configPath = path.join(homedir(), '.ngs-pipeline', 'app-config.json')
    try {
      configured = JSON.parse(await readFile(configPath, 'utf8')).rootDir
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Unable to read the NGS app results configuration.')
    }
  }
  if (!configured) throw new Error('Set NGS_RESULTS_ROOT or choose the data folder in Overview & Setup.')
  try {
    return await realpath(configured)
  } catch {
    throw new Error('The configured NGS results folder is unavailable.')
  }
}
