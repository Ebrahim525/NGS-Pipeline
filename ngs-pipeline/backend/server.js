import archiver from 'archiver'
import cors from 'cors'
import { spawn } from 'child_process'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'fs'
import fsPromises from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

const app = express()
const PORT = Number(process.env.PORT) || 8787

app.use(cors({ origin: true }))
app.use(express.json({ limit: '1mb' }))

const APP_CONFIG_PATH = path.join(os.homedir(), '.ngs-pipeline', 'app-config.json')
// Legacy location: inside backend/, which `node --watch` watches, causing restart loops on write.
const LEGACY_APP_CONFIG_PATH = path.join(__dirname, 'app-config.json')

/** Persisted app settings (e.g. chosen ngs_data root dir), stored outside the watched backend dir. */
function readAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(APP_CONFIG_PATH, 'utf8'))
  } catch {
    try {
      return JSON.parse(fs.readFileSync(LEGACY_APP_CONFIG_PATH, 'utf8'))
    } catch {
      return {}
    }
  }
}

function writeAppConfig(patch) {
  const next = { ...readAppConfig(), ...patch }
  fs.mkdirSync(path.dirname(APP_CONFIG_PATH), { recursive: true })
  fs.writeFileSync(APP_CONFIG_PATH, JSON.stringify(next, null, 2))
  return next
}

function javaExecutable() {
  if (process.env.JAVA_HOME) {
    const bin = path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    console.log(bin)
    if (fs.existsSync(bin)) return bin
  }
  return 'java'
}

/** Classpath relative to FASTQC project root (cwd for the JVM), or full FASTQC_CLASSPATH. */
function buildClasspath(fastqcDir) {
  console.log("process.env.FASTQC_CLASSPATH?.trim()")
  console.log(process.env.FASTQC_CLASSPATH?.trim())
  if (process.env.FASTQC_CLASSPATH?.trim()) {
    return process.env.FASTQC_CLASSPATH.trim()
  }
  const sep = path.delimiter
  return [fastqcDir, 'bin', 'sam-1.103.jar', 'jbzip2-0.9.jar'].join(sep)
}

function runFastqc({ fastqcDir, inputPaths, outDir }) {
  console.log("fastqcDir")
  console.log(fastqcDir)
  const cwd = path.resolve(fastqcDir)
  console.log("cwd")
  console.log(cwd)
  const classpath = buildClasspath(fastqcDir)
  console.log("classpath")
  console.log(classpath)
  const mem = process.env.FASTQC_JAVA_MEM || '250m'
  // Input file(s) must come before -o / --outdir; otherwise FastQC treats the output path as a sequence file.
  const args = [
    `-Xmx${mem}`,
    '-classpath',
    classpath,
    'uk.ac.babraham.FastQC.FastQCApplication',
    ...inputPaths,
    // '-o',
    // outDir,
  ]

  console.log(args)
  console.log(JSON.stringify(args))

  return new Promise((resolve, reject) => {
    const proc = spawn(javaExecutable(), args, {
      cwd,
      windowsHide: true,
    })
    console.log('pid:', proc.pid, 'cmd:', proc.spawnargs.join(' '))
    console.log("proc")
    console.log(proc)
    let stderr = ''
    let stdout = ''
    proc.stdout?.on('data', (d) => {
      console.log(d.toString())
      stdout += d.toString()
    })
    proc.stderr?.on('data', (d) => {
      console.log(d.toString())
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      /* if (code === 0) resolve({ stdout, stderr })
      else {
        const msg = [stderr, stdout].filter(Boolean).join('\n') || `exit ${code}`
        console.log(msg)
        reject(new Error(msg))
      } */
     if (code === 0) {
      try {
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        for (const ip of inputPaths) {
          // FastQC drops .fastq, .fq, .fastq.gz, or .fq.gz extensions and appends '_fastqc'
          const baseName = path.basename(ip).replace(/(\.fastq|\.fq)(\.gz)?$/i, '');
          const sourceDir = path.dirname(ip);

          for (const fileName of [`${baseName}_fastqc.html`, `${baseName}_fastqc.zip`]) {
            const oldPath = path.join(sourceDir, fileName);
            const newPath = path.join(outDir, fileName);
            if (!fs.existsSync(oldPath)) continue;
            try {
              fs.renameSync(oldPath, newPath);
            } catch (renameError) {
              if (renameError.code === 'EXDEV') {
                fs.copyFileSync(oldPath, newPath);
                fs.unlinkSync(oldPath);
              } else {
                throw renameError;
              }
            }
          }
        }

        resolve({ stdout, stderr });
      } catch (moveError) {
        reject(new Error(`FastQC succeeded, but moving files failed: ${moveError.message}`));
      }
    } else {
      const msg = [stderr, stdout].filter(Boolean).join('\n') || `exit ${code}`;
      console.log(msg);
      reject(new Error(msg));
    }
    })
  })
}

function zipDirectoryToResponse(dirPath, res) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.on('error', reject)
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') console.warn('archiver:', err)
    })
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="fastqc-results.zip"')
    archive.pipe(res)
    archive.directory(dirPath, false)
    archive.finalize().then(resolve).catch(reject)
  })
}

/** Escape a string for safe use inside a single-quoted bash literal. */
function bashSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** Escape a string for safe use inside a single-quoted PowerShell literal. */
function psSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/**
 * Bash word for paths or a single command token. Tilde must not be single-quoted — it will not
 * expand (e.g. '~/bwa/bwa' is wrong; use "$HOME/bwa/bwa").
 */
function bashWslWord(s) {
  const v = String(s).trim()
  if (v === '~') {
    return '"$HOME"'
  }
  if (v.startsWith('~/')) {
    const rest = v.slice(2)
    if (/[\r\n\0]/.test(rest)) {
      throw new Error('Path contains invalid characters')
    }
    const escaped = rest
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
    return `"$HOME/${escaped}"`
  }
  return bashSingleQuote(v)
}

/** Windows absolute path → Git Bash MSYS form (e.g. C:\\Users\\x → /c/Users/x). Unchanged on Unix. */
function toGitBashPath(absPath) {
  const resolved = path.resolve(absPath)
  if (process.platform !== 'win32') {
    return resolved.replace(/\\/g, '/')
  }
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(resolved)
  if (!m) {
    return resolved.replace(/\\/g, '/')
  }
  const rest = m[2].replace(/\\/g, '/')
  return `/mnt/${m[1].toLowerCase()}/${rest}`
}

/**
 * Windows absolute path with forward slashes (e.g. D:\\a\\b → D:/a/b) — kept as a native
 * drive-letter path. Real Git Bash's MSYS runtime (and the Windows java.exe bbduk.sh launches)
 * accept this form directly; it does NOT use the WSL-style /mnt/<drive> prefix from toGitBashPath.
 */
function toWinForwardSlashPath(absPath) {
  return path.resolve(absPath).replace(/\\/g, '/')
}

function parseTrimInt(val, defaultVal, label) {
  if (val === undefined || val === null || val === '') return defaultVal
  const x = Number(val)
  if (!Number.isInteger(x) || x < 1 || x > 999) {
    const err = new Error(`${label} must be an integer from 1 to 999`)
    err.status = 400
    throw err
  }
  return x
}

/** BBDuk ref= token: built-in name like adapters or a quoted MSYS path. */
function bbdukRefShellToken(refRaw) {
  const d = (refRaw ?? 'adapters').trim() || 'adapters'
  if (/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(d)) return d
  const p = assertSafePath('ref', refRaw)
  return bashSingleQuote(toWinForwardSlashPath(p))
}

function trimScriptBody(shellBody) {
  return `set -euo pipefail
${shellBody}`
}

function gitBashExecutable() {
  const fromEnv = process.env.GIT_BASH?.trim()
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const dirs = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean)
  for (const c of dirs) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function wslExecutable() {
  const wsl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')
  return fs.existsSync(wsl) ? wsl : null
}

/**
 * Run a bash script via Git Bash or WSL on Windows. On macOS/Linux uses bash on PATH.
 * Set GIT_BASH in .env to the full path of bash.exe, or to 'wsl' to force WSL.
 */
function runGitBashScript(script) {
  let exe, args
  if (process.platform !== 'win32') {
    exe = 'bash'
    args = ['-lc', script]
  } else {
    const fromEnv = process.env.GIT_BASH?.trim()
    // GIT_BASH=wsl forces WSL even if Git Bash is installed
    const useWsl = fromEnv === 'wsl' || fromEnv === 'wsl.exe' || (!fromEnv && !gitBashExecutable())
    if (useWsl) {
      const wsl = wslExecutable()
      if (!wsl) {
        const err = new Error('Neither Git Bash nor WSL found. Install Git for Windows, enable WSL, or set GIT_BASH in backend/.env.')
        err.status = 500
        return Promise.reject(err)
      }
      exe = wsl
      args = ['bash', '-lc', script]
    } else {
      exe = gitBashExecutable()
      args = ['-lc', script]
    }
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true })
    let stderr = ''
    let stdout = ''
    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    proc.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, exitCode: 0 })
      else {
        const msg = [stderr, stdout].filter(Boolean).join('\n') || `exit ${code}`
        const err = new Error(msg)
        err.exitCode = code
        reject(err)
      }
    })
  })
}

/** Reject paths that could break out of quoting or inject commands. */
function assertSafePath(label, p) {
  const v = String(p ?? '').trim()
  if (!v) {
    const err = new Error(`${label} is required`)
    err.status = 400
    throw err
  }
  if (/[\r\n\0]/.test(v)) {
    const err = new Error(`${label} contains invalid characters`)
    err.status = 400
    throw err
  }
  if (/[;`$]/.test(v) || /&&|\|\||\(|\)/.test(v)) {
    const err = new Error(`${label} must not contain shell metacharacters (; $ & | \` ( ) && ||)`)
    err.status = 400
    throw err
  }
  return v
}

/** BWA executable token only (e.g. bwa, ./bwa, /opt/bwa/bwa). */
function assertSafeBwaCmd(cmd) {
  const v = String(cmd ?? '').trim() || 'bwa'
  if (/\s/.test(v)) {
    const err = new Error('bwaCmd must be a single path or command name without spaces')
    err.status = 400
    throw err
  }
  if (/[;`$]/.test(v) || /&&|\|\||\(|\)/.test(v)) {
    const err = new Error('bwaCmd contains invalid characters')
    err.status = 400
    throw err
  }
  return v
}

/** HaplotypeCaller via `java -jar gatk-package-*-local.jar` (same Java as PICARD_JAVA / .env). */
function gatkHaplotypeCallerCommand(refPath, inputBam, outputVcf, reqBody) {
  const w = bashWslWord
  const jar =
    reqBody?.gatkJar?.trim() ||
    process.env.GATK_JAR?.trim() ||
    '~/ngs-pipeline/gatk-4.5.0.0/gatk-package-4.5.0.0-local.jar'
  assertSafePath('gatkJar', jar)
  let jopts = ''
  if (process.env.GATK_JAVA_OPTS !== undefined) {
    jopts = process.env.GATK_JAVA_OPTS.trim()
  }
  if (jopts && /[\r\n;`$&|<>]/.test(jopts)) {
    const err = new Error('GATK_JAVA_OPTS contains invalid characters')
    err.status = 400
    throw err
  }
  const javaBin = picardJavaExecutable()
  const optsPart = jopts ? `${jopts} ` : ''
  return `${javaBin} ${optsPart}-jar ${w(jar)} HaplotypeCaller -R ${w(refPath)} -I ${w(inputBam)} -O ${w(outputVcf)}`
}

function assertSafeVepCmd(cmd) {
  const v = String(cmd ?? '').trim() || 'vep'
  if (/\s/.test(v)) {
    const err = new Error('vepCmd must be a single path or command name without spaces')
    err.status = 400
    throw err
  }
  if (/[;`$]/.test(v) || /&&|\|\||\(|\)/.test(v)) {
    const err = new Error('vepCmd contains invalid characters')
    err.status = 400
    throw err
  }
  return v
}

function vepForkCount(fork) {
  if (fork === undefined || fork === null || fork === '') return 4
  const x = Number(fork)
  if (!Number.isInteger(x) || x < 1 || x > 16) {
    const err = new Error('fork must be an integer from 1 to 16')
    err.status = 400
    throw err
  }
  return x
}

function vepExecutableFromRequest(reqBody) {
  const fromBody = reqBody?.vepCmd?.trim()
  if (fromBody) return assertSafeVepCmd(fromBody)
  const fromEnv = process.env.VEP_CMD?.trim()
  if (fromEnv) return assertSafeVepCmd(fromEnv)
  return 'vep'
}

/** Conda env name for `conda run -n … vep` (safe subset: letters, digits, _, -, .). */
function assertSafeCondaEnvName(name) {
  const v = String(name ?? '').trim()
  if (!/^[a-zA-Z0-9][-._a-zA-Z0-9]*$/.test(v)) {
    const err = new Error('Invalid conda env name (use something like vep_env)')
    err.status = 400
    throw err
  }
  return v
}

function vepCondaEnvFromRequest(reqBody) {
  const fromBody = reqBody?.vepCondaEnv?.trim()
  if (fromBody) return assertSafeCondaEnvName(fromBody)
  const fromEnv = process.env.VEP_CONDA_ENV?.trim()
  if (fromEnv) return assertSafeCondaEnvName(fromEnv)
  return null
}

function condaExecutableToken() {
  const raw = process.env.CONDA_EXE?.trim()
  if (!raw) return 'conda'
  try {
    return assertSafeVepCmd(raw)
  } catch {
    return 'conda'
  }
}

function pythonExecutable() {
  const fromEnv = process.env.PYTHON_BIN?.trim()
  if (fromEnv) return fromEnv
  // 'py' is the Windows Python Launcher (ships with all python.org installers).
  // If you use Conda/venv, set PYTHON_BIN to the full path in backend/.env.
  return process.platform === 'win32' ? 'py' : 'python3'
}

/**
 * Ensembl VEP: --cache --offline. Optionally wrap with `conda run -n env --no-capture-output` so
 * Perl sees the env’s modules (fixes missing DBI when activation from bash -ilc is incomplete).
 */
function vepAnnotationCommand(inputVcf, outputVcf, fastaPath, fork, reqBody) {
  const w = bashWslWord
  const vep = vepExecutableFromRequest(reqBody)
  const f = vepForkCount(fork)
  const inner = `${w(vep)} --cache --offline --fork ${f} -i ${w(inputVcf)} -o ${w(outputVcf)} --vcf --symbol --terms SO --hgvs --protein --canonical --fasta ${w(fastaPath)} --force_overwrite`

  const condaEnv = vepCondaEnvFromRequest(reqBody)
  if (condaEnv) {
    const conda = condaExecutableToken()
    return `${w(conda)} run -n ${condaEnv} --no-capture-output ${inner}`
  }
  return inner
}

/** Picard launcher token — same rules as a bare command name (like `samtools` in this file). */
function assertSafePicardCmd(cmd) {
  const v = String(cmd ?? '').trim() || 'picard'
  if (/\s/.test(v)) {
    const err = new Error('picardCmd must be a single path or command name without spaces')
    err.status = 400
    throw err
  }
  if (/[;`$]/.test(v) || /&&|\|\||\(|\)/.test(v)) {
    const err = new Error('picardCmd contains invalid characters')
    err.status = 400
    throw err
  }
  return v
}

/**
 * Linux Picard launcher path. Default is /usr/bin/picard (not bare `picard`): on WSL, PATH often
 * finds Windows `picard.exe` (MusicBrainz music tagger) first — wrong binary, wrong GUI.
 * Override with PICARD_CMD or use PICARD_JAR + java -jar (see picardMarkDuplicatesCommand).
 */
function picardExecutable() {
  const raw = process.env.PICARD_CMD?.trim()
  if (raw) {
    try {
      return assertSafePicardCmd(raw)
    } catch {
      return '/usr/bin/picard'
    }
  }
  return '/usr/bin/picard'
}

/** Full path to java for Picard jar mode (same token rules as PICARD_CMD). */
function assertSafeJavaBin(cmd) {
  const v = String(cmd ?? '').trim() || 'java'
  if (/\s/.test(v)) {
    const err = new Error('PICARD_JAVA must be a single path without spaces')
    err.status = 400
    throw err
  }
  if (/[;`$]/.test(v) || /&&|\|\||\(|\)/.test(v)) {
    const err = new Error('PICARD_JAVA contains invalid characters')
    err.status = 400
    throw err
  }
  return v
}

function picardJavaExecutable() {
  const raw = process.env.PICARD_JAVA?.trim()
  if (!raw) return 'java'
  try {
    return assertSafeJavaBin(raw)
  } catch {
    return 'java'
  }
}

/**
 * When PICARD_JAR is set: `${PICARD_JAVA} [PICARD_JAVA_OPTS] -jar jar MarkDuplicates …`
 * Matches e.g. `/usr/lib/jvm/java-17-openjdk-amd64/bin/java -jar ~/picard.jar MarkDuplicates I=…`
 */
function picardMarkDuplicatesCommand(inputBam, outputBam, metricsPath) {
  const w = bashWslWord
  const jar = process.env.PICARD_JAR?.trim()
  if (jar) {
    assertSafePath('PICARD_JAR', jar)
    let jopts = ''
    if (process.env.PICARD_JAVA_OPTS === undefined) {
      jopts = ''
    } else {
      jopts = process.env.PICARD_JAVA_OPTS.trim()
    }
    if (jopts && /[\r\n;`$&|<>]/.test(jopts)) {
      const err = new Error('PICARD_JAVA_OPTS contains invalid characters')
      err.status = 400
      throw err
    }
    const javaBin = picardJavaExecutable()
    const optsPart = jopts ? `${jopts} ` : ''
    return `${javaBin} ${optsPart}-jar ${w(jar)} MarkDuplicates I=${w(inputBam)} O=${w(outputBam)} M=${w(metricsPath)}`
  }
  const picardBin = picardExecutable()
  return `${picardBin} MarkDuplicates I=${w(inputBam)} O=${w(outputBam)} M=${w(metricsPath)}`
}

function useWslForAlignment() {
  if (process.env.ALIGN_USE_WSL === '0' || process.env.ALIGN_USE_WSL === 'false') {
    return false
  }
  return process.platform === 'win32'
}

/**
 * Optional lines run before `set -euo pipefail` (e.g. Conda init if interactive .bashrc is not enough).
 * Set ALIGN_WSL_PROLOGUE in backend/.env — runs inside the same bash as BWA/samtools.
 */
function alignmentPrologue() {
  const p = process.env.ALIGN_WSL_PROLOGUE?.trim()
  return p || ''
}

function wrapWithPrologue(shellBody) {
  const pro = alignmentPrologue()
  if (pro) {
    return `${pro}
set -euo pipefail
${shellBody}`
  }
  return `set -euo pipefail
${shellBody}`
}

/**
 * Bash must be interactive + login so Ubuntu/WSL .bashrc runs past the non-interactive guard;
 * otherwise conda init never runs and `bwa` / `samtools` are missing from PATH.
 * See: https://github.com/conda/conda/issues/8169
 */
function bashInvocationArgs(script) {
  // -i = interactive (sources full .bashrc including conda), -l = login shell
  return ['bash', '-ilc', script]
}

/**
 * Run a bash script. On Windows, runs inside WSL so bwa/samtools match your WSL install.
 */
function runBashScript(script) {
  const wsl = useWslForAlignment()
  const argv = bashInvocationArgs(script)

  return new Promise((resolve, reject) => {
    const proc = wsl
      ? spawn('wsl.exe', argv, { windowsHide: true })
      : spawn(argv[0], argv.slice(1), { windowsHide: true })
    let stderr = ''
    let stdout = ''
    proc.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    proc.stderr?.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, exitCode: 0 })
      else {
        const msg = [stderr, stdout].filter(Boolean).join('\n') || `exit ${code}`
        const err = new Error(msg)
        err.exitCode = code
        reject(err)
      }
    })
  })
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/alignment/index-ref', async (req, res) => {
  try {
    const bwaCmd = assertSafeBwaCmd(req.body?.bwaCmd)
    const refPathRaw = req.body?.refPath?.trim() || '/home/ngs/hg38.fa'
    const refPath = assertSafePath('refPath', refPathRaw)

    const w = bashWslWord
    const pipeline = `${w(bwaCmd)} index ${w(refPath)}`
    const script = wrapWithPrologue(pipeline)

    const { stdout, stderr } = await runBashScript(script)
    res.json({ ok: true, stdout, stderr, exitCode: 0, command: `${bwaCmd} index ${refPath}` })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'Reference indexing command failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
})

app.post('/api/alignment/run', async (req, res) => {
  try {
    const bwaCmd = assertSafeBwaCmd(req.body?.bwaCmd)
    const refPathRaw = req.body?.refPath?.trim() || '/home/ngs/hg38.fa'
    const refPath = assertSafePath('refPath', refPathRaw)
    const fastqPath = assertSafePath('fastqPath', req.body?.fastqPath)

    const patientDirRaw = req.body?.patientDir
    // Convert Windows backslashes to forward slashes for cross‑platform compatibility
    const patientDirNorm = typeof patientDirRaw === 'string' ? patientDirRaw.replace(/\\/g, '/') : patientDirRaw
    if (!String(patientDirNorm ?? '').trim()) {
      return res.status(400).json({ error: 'patientDir is required. Select or create a patient folder before running alignment.' })
    }
    let patientDir
    try {
      patientDir = path.resolve(assertSafePath('patientDir', patientDirNorm))
      await fsPromises.access(patientDir, fs.constants.W_OK)
    } catch {
      return res.status(400).json({ error: `Patient folder is not writable or does not exist: ${patientDirRaw}` })
    }

    // Save output into an alignment subfolder under the patient folder, as aligned_sorted.bam
    const alignmentDir = path.join(patientDir, 'alignment')
    try {
      await fsPromises.mkdir(alignmentDir, { recursive: true })
    } catch (e) {
      return res.status(500).json({ error: `Could not create output folder: ${alignmentDir}`, detail: e.message })
    }
    const outBamWin = path.join(alignmentDir, 'aligned_sorted.bam')
    const outBamPath = toGitBashPath(outBamWin)

    const w = bashWslWord
    const pipeline = `${w(bwaCmd)} mem ${w(refPath)} ${w(fastqPath)} | samtools view -Sb - | samtools sort -o ${w(outBamPath)}`
    const script = wrapWithPrologue(pipeline)

    const { stdout, stderr } = await runBashScript(script)
    res.json({ ok: true, stdout, stderr, exitCode: 0, outBamPath, outBamWin })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'Alignment command failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
})

app.post('/api/alignment/index-bam', async (req, res) => {
  try {
    const bamPath = assertSafePath('bamPath', req.body?.bamPath)

    const w = bashWslWord
    const pipeline = `samtools index ${w(bamPath)}`
    const script = wrapWithPrologue(pipeline)

    const { stdout, stderr } = await runBashScript(script)
    res.json({ ok: true, stdout, stderr, exitCode: 0 })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'samtools index failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
})

app.post('/api/post-alignment/mark-duplicates', async (req, res) => {
  try {
    const inputBam = assertSafePath('inputBam', req.body?.inputBam)

    const patientDirRaw = req.body?.patientDir
    // Convert Windows backslashes to forward slashes for cross‑platform compatibility
    const patientDirNorm = typeof patientDirRaw === 'string' ? patientDirRaw.replace(/\\/g, '/') : patientDirRaw
    if (!String(patientDirNorm ?? '').trim()) {
      return res.status(400).json({ error: 'patientDir is required. Select or create a patient folder before running MarkDuplicates.' })
    }
    let patientDir
    try {
      patientDir = path.resolve(assertSafePath('patientDir', patientDirNorm))
      await fsPromises.access(patientDir, fs.constants.W_OK)
    } catch {
      return res.status(400).json({ error: `Patient folder is not writable or does not exist: ${patientDirRaw}` })
    }

    // Save output into a post_alignment subfolder under the patient folder
    const postAlignDir = path.join(patientDir, 'post_alignment')
    try {
      await fsPromises.mkdir(postAlignDir, { recursive: true })
    } catch (e) {
      return res.status(500).json({ error: `Could not create output folder: ${postAlignDir}`, detail: e.message })
    }
    const outputBam = toGitBashPath(path.join(postAlignDir, 'dedup.bam'))
    const metricsPath = toGitBashPath(path.join(postAlignDir, 'dup_metrics.txt'))

    const pipeline = picardMarkDuplicatesCommand(inputBam, outputBam, metricsPath)
    const script = wrapWithPrologue(pipeline)

    const { stdout, stderr } = await runBashScript(script)
    res.json({ ok: true, stdout, stderr, exitCode: 0, outputBam, metricsPath })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'Picard MarkDuplicates failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
})

app.post('/api/variant-calling/prepare-reference', async (req, res) => {
  try {
    const refPath = assertSafePath('refPath', req.body?.refPath);
    const jar = req.body?.gatkJar?.trim() ||
      process.env.GATK_JAR?.trim() ||
      '~/ngs-pipeline/gatk-4.5.0.0/gatk-package-4.5.0.0-local.jar';
    // Validate jar path
    assertSafePath('gatkJar', jar);
    const resolvedRef = path.resolve(refPath);
    await fsPromises.access(resolvedRef, fs.constants.R_OK);
    // Commands
    const faidxCmd = `samtools faidx ${bashSingleQuote(toWinForwardSlashPath(resolvedRef))}`;
    const dictCmd = `${bashSingleQuote(JAVA_PREVIEW)} -jar ${bashSingleQuote(toWinForwardSlashPath(jar))} CreateSequenceDictionary -R ${bashSingleQuote(toWinForwardSlashPath(resolvedRef))} -O ${bashSingleQuote(toWinForwardSlashPath(`${resolvedRef}.dict`))}`;
    const script = trimScriptBody(`cd ${bashSingleQuote(toWinForwardSlashPath(path.dirname(resolvedRef)))} && ${faidxCmd} && ${dictCmd}`);
    const { stdout, stderr } = await runBashScript(script);
    res.json({ ok: true, stdout, stderr, commands: { faidx: faidxCmd, dict: dictCmd } });
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message });
    }
    return res.status(500).json({ error: 'Reference preparation failed', detail: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/variant-calling/add-read-groups', async (req, res) => {
  try {
    const inputBam = assertSafePath('inputBam', req.body?.inputBam)

    const patientDirRaw = req.body?.patientDir
    const patientDirNorm = typeof patientDirRaw === 'string' ? patientDirRaw.replace(/\\/g, '/') : patientDirRaw
    if (!String(patientDirNorm ?? '').trim()) {
      return res.status(400).json({ error: 'patientDir is required. Select or create a patient folder before running AddOrReplaceReadGroups.' })
    }
    let patientDir
    try {
      patientDir = path.resolve(assertSafePath('patientDir', patientDirNorm))
      await fsPromises.access(patientDir, fs.constants.W_OK)
    } catch {
      return res.status(400).json({ error: `Patient folder is not writable or does not exist: ${patientDirRaw}` })
    }

    const vcDir = path.join(patientDir, 'variant_calling')
    try {
      await fsPromises.mkdir(vcDir, { recursive: true })
    } catch (e) {
      return res.status(500).json({ error: `Could not create output folder: ${vcDir}`, detail: e.message })
    }
    const outputBam = toGitBashPath(path.join(vcDir, 'dedup_rg.bam'))
    const rgid = String(req.body?.rgid ?? '1').replace(/[^a-zA-Z0-9._-]/g, '')
    const rglb = String(req.body?.rglb ?? 'lib1').replace(/[^a-zA-Z0-9._-]/g, '')
    const rgpl = String(req.body?.rgpl ?? 'ILLUMINA').replace(/[^a-zA-Z0-9._-]/g, '')
    const rgpu = String(req.body?.rgpu ?? 'unit1').replace(/[^a-zA-Z0-9._-]/g, '')
    const rgsm = String(req.body?.rgsm ?? 'sample1').replace(/[^a-zA-Z0-9._-]/g, '')

    const jar = process.env.PICARD_JAR?.trim() || '~/ngs-pipeline/picard.jar'
    assertSafePath('PICARD_JAR', jar)
    let jopts = ''
    if (process.env.PICARD_JAVA_OPTS !== undefined) {
      jopts = process.env.PICARD_JAVA_OPTS.trim()
    }
    if (jopts && /[\r\n;`$&|<>]/.test(jopts)) {
      const err = new Error('PICARD_JAVA_OPTS contains invalid characters')
      err.status = 400
      throw err
    }
    const javaBin = picardJavaExecutable()
    const optsPart = jopts ? `${jopts} ` : ''
    const w = bashWslWord
    const pipeline = `${javaBin} ${optsPart}-jar ${w(jar)} AddOrReplaceReadGroups I=${w(inputBam)} O=${w(outputBam)} RGID=${rgid} RGLB=${rglb} RGPL=${rgpl} RGPU=${rgpu} RGSM=${rgsm}`
    const script = wrapWithPrologue(pipeline)

    const { stdout, stderr } = await runBashScript(script)
    res.json({ ok: true, stdout, stderr, exitCode: 0, outputBam })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'AddOrReplaceReadGroups failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
})

app.post('/api/variant-calling/haplotype-caller', async (req, res) => {
  try {
    const refPath = assertSafePath('refPath', req.body?.refPath)
    const inputBam = assertSafePath('inputBam', req.body?.inputBam)
    const outputVcf = assertSafePath('outputVcf', req.body?.outputVcf)

    const pipeline = gatkHaplotypeCallerCommand(refPath, inputBam, outputVcf, req.body)
    const script = wrapWithPrologue(pipeline)

    const { stdout, stderr } = await runBashScript(script)
    res.json({ ok: true, stdout, stderr, exitCode: 0 })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'GATK HaplotypeCaller failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
})

app.post('/api/variant-annotation/run', async (req, res) => {
  try {
    const inputVcf = assertSafePath('inputVcf', req.body?.inputVcf)
    const outputVcf = assertSafePath('outputVcf', req.body?.outputVcf)
    const fastaPath = assertSafePath('fastaPath', req.body?.fastaPath)

    const pipeline = vepAnnotationCommand(inputVcf, outputVcf, fastaPath, req.body?.fork, req.body)
    const script = wrapWithPrologue(pipeline)

    const { stdout, stderr } = await runBashScript(script)
    res.json({ ok: true, stdout, stderr, exitCode: 0 })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'VEP annotation failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
})

/** Upload a VCF file and save it under backend/uploads/; returns the absolute saved path. */
app.post('/api/upload-vcf', express.text({ limit: '50mb', type: '*/*' }), async (req, res) => {
  try {
    const filename = path.basename(req.headers['x-filename'] || 'upload.vcf').replace(/[^a-zA-Z0-9._-]/g, '_')
    if (!filename.match(/\.vcf$/i)) {
      return res.status(400).json({ error: 'Only .vcf files are accepted.' })
    }
    const uploadsDir = path.join(__dirname, 'uploads')
    await fsPromises.mkdir(uploadsDir, { recursive: true })
    const dest = path.join(uploadsDir, filename)
    await fsPromises.writeFile(dest, req.body, 'utf8')
    res.json({ savedPath: dest })
  } catch (e) {
    res.status(500).json({ error: 'Upload failed.', detail: e.message })
  }
})

/**
 * CIViC downstream clinical report generator:
 * python vcf_report_generator.py <input.vcf> --output clinical_report.html
 *
 * The script and civic_chroma_db are expected inside CIVIC_REPORT_DIR by default.
 */
app.post('/api/downstream/civic-report', async (req, res) => {
  try {
    const bundledReportDir = path.join(__dirname, 'tools', 'civic_report')
    const reportDirRaw = process.env.CIVIC_REPORT_DIR?.trim()
    const scriptRaw = req.body?.scriptPath?.trim() || process.env.CIVIC_REPORT_SCRIPT?.trim()
    const dbRaw = req.body?.dbDir?.trim() || process.env.CIVIC_CHROMA_DB_DIR?.trim()
    const inputVcf = assertSafePath('inputVcf', req.body?.inputVcf)
    const outputHtml = assertSafePath('outputHtml', req.body?.outputHtml)

    const normReportDirRaw = reportDirRaw && process.platform !== 'win32'
      ? reportDirRaw.replace(/\\/g, '/')
      : reportDirRaw

    let reportDir = normReportDirRaw ? path.resolve(normReportDirRaw) : null
    if ((!reportDir || !fs.existsSync(reportDir)) && fs.existsSync(bundledReportDir)) {
      reportDir = bundledReportDir
    }

    const normScriptRaw = scriptRaw && process.platform !== 'win32'
      ? scriptRaw.replace(/\\/g, '/')
      : scriptRaw
    let scriptPath = normScriptRaw ? path.resolve(normScriptRaw) : null
    if ((!scriptPath || !fs.existsSync(scriptPath)) && reportDir) {
      scriptPath = path.join(reportDir, 'vcf_report_generator.py')
    }

    const normDbRaw = dbRaw && process.platform !== 'win32'
      ? dbRaw.replace(/\\/g, '/')
      : dbRaw
    let dbDir = normDbRaw ? path.resolve(normDbRaw) : null
    if ((!dbDir || !fs.existsSync(dbDir)) && reportDir) {
      dbDir = path.join(reportDir, 'civic_chroma_db')
    }

    if (!scriptPath || !dbDir) {
      return res.status(500).json({
        error:
          'CIViC report generator script or civic_chroma_db folder not found. Ensure tools/civic_report exists under backend/ or set CIVIC_REPORT_DIR in backend/.env.',
      })
    }

    try {
      await fsPromises.access(scriptPath, fs.constants.R_OK)
    } catch {
      return res.status(400).json({ error: `Python script not found or not readable: ${scriptPath}` })
    }
    try {
      await fsPromises.access(dbDir, fs.constants.R_OK)
    } catch {
      return res.status(400).json({ error: `civic_chroma_db folder not found or not readable: ${dbDir}` })
    }

    const normInputVcf = process.platform !== 'win32' ? inputVcf.replace(/\\/g, '/') : inputVcf
    const normOutputHtml = process.platform !== 'win32' ? outputHtml.replace(/\\/g, '/') : outputHtml
    const resolvedInput = path.resolve(normInputVcf)
    const resolvedOutput = path.resolve(normOutputHtml)
    const outputParent = path.dirname(resolvedOutput)

    try {
      await fsPromises.access(resolvedInput, fs.constants.R_OK)
    } catch {
      return res.status(400).json({ error: `Input VCF not found or not readable: ${resolvedInput}` })
    }
    try {
      await fsPromises.mkdir(outputParent, { recursive: true })
      await fsPromises.access(outputParent, fs.constants.W_OK)
    } catch {
      return res.status(400).json({ error: `Output folder is not writable: ${outputParent}` })
    }

    const args = [scriptPath, resolvedInput, '--output', resolvedOutput]
    const env = { ...process.env, CIVIC_CHROMA_DB_DIR: dbDir }

    const result = await new Promise((resolve, reject) => {
      const proc = spawn(pythonExecutable(), args, {
        windowsHide: true,
        cwd: path.dirname(scriptPath),
        env,
      })
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (d) => {
        stdout += d.toString()
      })
      proc.stderr?.on('data', (d) => {
        stderr += d.toString()
      })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr, exitCode: 0 })
          return
        }
        const msg = [stderr, stdout].filter(Boolean).join('\n') || `exit ${code}`
        const err = new Error(msg)
        err.exitCode = code
        reject(err)
      })
    })

    return res.json({
      ok: true,
      ...result,
      scriptPath,
      dbDir,
      inputVcf: resolvedInput,
      outputHtml: resolvedOutput,
      command: `${pythonExecutable()} "${scriptPath}" "${resolvedInput}" --output "${resolvedOutput}"`,
    })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'CIViC report generation failed',
      detail: e instanceof Error
        ? (e.message.includes('ENOENT')
          ? `Python executable "${pythonExecutable()}" not found. Set PYTHON_BIN in backend/.env to your Python path (e.g. py, python3, or C:\\Python312\\python.exe).`
          : e.message)
        : String(e),
    })
  }
})

/**
 * Adapter / quality trimming with BBMap bbduk.sh via Git Bash (Windows) or bash (Unix).
 * Configure BBMAP_DIR to the folder containing bbduk.sh (e.g. .../BBMap_39.01/bbmap).
 */
app.post('/api/trimming/bbduk', async (req, res) => {
  try {
    const bbmapDir = process.env.BBMAP_DIR?.trim()
    if (!bbmapDir) {
      return res.status(500).json({
        error:
          'Set environment variable BBMAP_DIR to your BBMap installation directory (the folder that contains bbduk.sh).',
      })
    }
    const resolvedBbmap = path.resolve(bbmapDir)
    const bbdukSh = path.join(resolvedBbmap, 'bbduk.sh')
    try {
      await fsPromises.access(bbdukSh, fs.constants.R_OK)
    } catch {
      return res.status(500).json({ error: `bbduk.sh not found in BBMAP_DIR: ${bbmapDir}` })
    }

    const inputPath = assertSafePath('inputPath', req.body?.inputPath)
    const resolvedIn = path.resolve(inputPath)
    try {
      await fsPromises.access(resolvedIn, fs.constants.R_OK)
    } catch {
      return res.status(400).json({ error: `Input FASTQ not found or not readable: ${inputPath}` })
    }

    const patientDirRaw = req.body?.patientDir
    // Convert Windows backslashes to forward slashes for cross‑platform compatibility
    const patientDirNorm = typeof patientDirRaw === 'string' ? patientDirRaw.replace(/\\/g, '/') : patientDirRaw
    if (!String(patientDirNorm ?? '').trim()) {
      return res.status(400).json({ error: 'patientDir is required. Select or create a patient folder before running BBDuk.' })
    }
    let patientDir
    try {
      patientDir = path.resolve(assertSafePath('patientDir', patientDirNorm))
      await fsPromises.access(patientDir, fs.constants.W_OK)
    } catch {
      return res.status(400).json({ error: `Patient folder is not writable or does not exist: ${patientDirRaw}` })
    }

    // Save output into a trimming subfolder under the patient folder, as cleaned_<original name>
    const trimmingDir = path.join(patientDir, 'trimming')
    try {
      await fsPromises.mkdir(trimmingDir, { recursive: true })
    } catch (e) {
      return res.status(500).json({ error: `Could not create output folder: ${trimmingDir}`, detail: e.message })
    }
    const resolvedOut = path.join(trimmingDir, `cleaned_${path.basename(resolvedIn)}`)

    const sq = bashSingleQuote
    const msysIn = toWinForwardSlashPath(resolvedIn)
    const msysOut = toWinForwardSlashPath(resolvedOut)
    const refTok = bbdukRefShellToken(req.body?.ref)
    const k = parseTrimInt(req.body?.k, 23, 'k')
    const mink = parseTrimInt(req.body?.mink, 11, 'mink')
    const hdist = parseTrimInt(req.body?.hdist, 1, 'hdist')
    const trimq = parseTrimInt(req.body?.trimq, 20, 'trimq')
    const minlen = parseTrimInt(req.body?.minlen, 30, 'minlen')

    const defaultLine = `./bbduk.sh in=${sq(msysIn)} out=${sq(msysOut)} ref=${refTok} ktrim=r k=${k} mink=${mink} hdist=${hdist} qtrim=r trimq=${trimq} minlen=${minlen}`
    const commandFromUser = String(req.body?.command ?? '')
      .replace(/\\\r?\n\s*/g, ' ') // collapse backslash-newline continuations
      .replace(/\r?\n/g, ' ')       // collapse any remaining newlines
      .trim()
    if (/[\0]/.test(commandFromUser)) {
      return res.status(400).json({ error: 'command contains invalid characters' })
    }
    const line = commandFromUser || defaultLine
    const script = trimScriptBody(`cd ${sq(toWinForwardSlashPath(resolvedBbmap))} && ${line}`)

    const { stdout, stderr } = await runGitBashScript(script)
    res.json({
      ok: true,
      stdout,
      stderr,
      exitCode: 0,
      outputPath: resolvedOut,
      command: line,
    })
  } catch (e) {
    if (e && typeof e.status === 'number') {
      return res.status(e.status).json({ error: e.message })
    }
    return res.status(500).json({
      error: 'BBDuk failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
})

/** PowerShell snippet setting a dialog's InitialDirectory, or '' if dir is missing/invalid. */
function pickerInitialDirLine(dir) {
  const v = String(dir ?? '').trim()
  if (!v || /[\r\n\0]/.test(v)) return ''
  const resolved = path.resolve(v)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return ''
  return `$dialog.InitialDirectory = ${psSingleQuote(resolved)}`
}

app.post('/api/file-picker', async (req, res) => {
  if (process.platform === 'win32') {
    const initialDirLine = pickerInitialDirLine(req.body?.initialDir)
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.WindowState = 'Minimized'
$owner.ShowInTaskbar = $false
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select input file'
$dialog.Filter = 'FASTQ / BAM files (*.fastq;*.fq;*.fastq.gz;*.fq.gz;*.bam;*.sam)|*.fastq;*.fq;*.fastq.gz;*.fq.gz;*.bam;*.sam|All files (*.*)|*.*'
$dialog.Multiselect = $false
${initialDirLine}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
  exit 0
}
exit 1
`
    return new Promise((resolve) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: false,
      })
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (d) => { stdout += d.toString() })
      proc.stderr?.on('data', (d) => { stderr += d.toString() })
      proc.on('error', () => resolve(res.json({ filePath: null, needsBrowserPicker: true })))
      proc.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(res.json({ filePath: stdout.trim() }))
        } else if (code === 1) {
          resolve(res.json({ filePath: null, cancelled: true }))
        } else {
          resolve(res.json({ filePath: null, needsBrowserPicker: true }))
        }
      })
    })
  } else if (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    try {
      const initialDir = req.body?.initialDir ? path.resolve(req.body.initialDir) : os.homedir()
      const picked = await new Promise((resolve) => {
        const proc = spawn('zenity', ['--file-selection', `--filename=${initialDir}/`], { windowsHide: false })
        let stdout = ''
        proc.stdout?.on('data', (d) => { stdout += d.toString() })
        proc.on('error', () => {
          const kproc = spawn('kdialog', ['--getopenfilename', initialDir])
          let kout = ''
          kproc.stdout?.on('data', (d) => { kout += d.toString() })
          kproc.on('error', () => resolve(null))
          kproc.on('close', (code) => {
            if (code === 0 && kout.trim()) resolve(kout.trim())
            else resolve(null)
          })
        })
        proc.on('close', (code) => {
          if (code === 0 && stdout.trim()) resolve(stdout.trim())
          else if (code === 1) resolve({ cancelled: true })
          else resolve(null)
        })
      })
      if (picked && typeof picked === 'object' && picked.cancelled) {
        return res.json({ filePath: null, cancelled: true })
      }
      if (typeof picked === 'string' && picked.trim()) {
        return res.json({ filePath: picked.trim() })
      }
    } catch {
      // Fall through to in-browser picker
    }
  }

  // Fallback: inform frontend to display built-in file browser modal
  return res.json({ filePath: null, needsBrowserPicker: true })
})

app.post('/api/folder-picker', async (req, res) => {
  if (process.platform === 'win32') {
    const initialDirLine = pickerInitialDirLine(req.body?.initialDir)
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.WindowState = 'Minimized'
$owner.ShowInTaskbar = $false
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select output folder'
$dialog.ShowNewFolderButton = $true
${initialDirLine}
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
  exit 0
}
exit 1
`
    return new Promise((resolve) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: false,
      })
      let stdout = ''
      proc.stdout?.on('data', (d) => { stdout += d.toString() })
      proc.stderr?.on('data', (d) => { stderr += d.toString() })
      proc.on('error', (e) => resolve(res.status(500).json({ error: e.message })))
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(res.json({ folderPath: stdout.trim() }))
        } else {
          resolve(res.json({ folderPath: null, cancelled: true }))
        }
      })
    })
  }

  // Linux / macOS: check if desktop GUI display is active
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    const rawInit = req.body?.initialDir?.trim()
    const initialDir = rawInit ? path.resolve(rawInit) : os.homedir()
    try {
      const picked = await new Promise((resolve) => {
        const proc = spawn('zenity', [
          '--file-selection',
          '--directory',
          '--title=Select Location for ngs_data',
          `--filename=${initialDir.endsWith('/') ? initialDir : initialDir + '/'}`,
        ])
        let stdout = ''
        proc.stdout?.on('data', (d) => { stdout += d.toString() })
        proc.on('error', () => {
          // Zenity not found; try kdialog
          const kproc = spawn('kdialog', ['--getexistingdirectory', initialDir])
          let kout = ''
          kproc.stdout?.on('data', (d) => { kout += d.toString() })
          kproc.on('error', () => resolve(null))
          kproc.on('close', (code) => {
            if (code === 0 && kout.trim()) resolve(kout.trim())
            else resolve(null)
          })
        })
        proc.on('close', (code) => {
          if (code === 0 && stdout.trim()) resolve(stdout.trim())
          else if (code === 1) resolve({ cancelled: true })
          else resolve(null)
        })
      })
      if (picked && typeof picked === 'object' && picked.cancelled) {
        return res.json({ folderPath: null, cancelled: true })
      }
      if (typeof picked === 'string' && picked.trim()) {
        return res.json({ folderPath: picked.trim() })
      }
    } catch {
      // Fall through to in-browser picker
    }
  }

  // Fallback: inform frontend to display built-in folder browser
  return res.json({ folderPath: null, needsBrowserPicker: true })
})

/** Directory browser for in-browser folder picker (works cross-platform: Linux, macOS, Windows). */
app.get('/api/setup/browse-folders', async (req, res) => {
  try {
    const rawPath = String(req.query?.dir ?? '').trim()
    const base = rawPath ? assertSafePath('dir', rawPath) : os.homedir()
    const norm = process.platform !== 'win32' ? base.replace(/\\/g, '/') : base
    const current = path.resolve(norm)
    const parent = path.dirname(current) !== current ? path.dirname(current) : null
    let entries = []
    let writable = false
    try {
      await fsPromises.access(current, fs.constants.W_OK)
      writable = true
    } catch {
      writable = false
    }
    try {
      const dirEntries = await fsPromises.readdir(current, { withFileTypes: true })
      entries = dirEntries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
    } catch {
      entries = []
    }
    return res.json({ current, parent, folders: entries, writable, homeDir: os.homedir() })
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message })
  }
})

/** Directory and file browser for in-browser file picker (works cross-platform: Linux, macOS, Windows). */
app.get('/api/setup/browse-files', async (req, res) => {
  try {
    const rawPath = String(req.query?.dir ?? '').trim()
    const base = rawPath ? assertSafePath('dir', rawPath) : os.homedir()
    const norm = process.platform !== 'win32' ? base.replace(/\\/g, '/') : base
    let current = path.resolve(norm)

    try {
      const st = await fsPromises.stat(current)
      if (st.isFile()) {
        current = path.dirname(current)
      }
    } catch {
      if (!fs.existsSync(current)) {
        const p = path.dirname(current)
        if (fs.existsSync(p)) current = p
        else current = os.homedir()
      }
    }

    const parent = path.dirname(current) !== current ? path.dirname(current) : null
    let folders = []
    let files = []
    let writable = false

    try {
      await fsPromises.access(current, fs.constants.W_OK)
      writable = true
    } catch {
      writable = false
    }

    try {
      const dirEntries = await fsPromises.readdir(current, { withFileTypes: true })
      for (const entry of dirEntries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          folders.push(entry.name)
        } else if (entry.isFile()) {
          files.push(entry.name)
        }
      }
      folders.sort((a, b) => a.localeCompare(b))
      files.sort((a, b) => a.localeCompare(b))
    } catch {
      folders = []
      files = []
    }

    return res.json({ current, parent, folders, files, writable, homeDir: os.homedir() })
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message })
  }
})

app.get('/api/setup/root-dir-info', (_req, res) => {
  res.json({ defaultBase: os.homedir() })
})

/** The previously configured ngs_data root dir, if any, so other steps can reuse it. */
app.get('/api/setup/root-dir', (_req, res) => {
  res.json({ rootDir: readAppConfig().rootDir || null })
})

app.post('/api/setup/root-dir', async (req, res) => {
  try {
    const baseInput = req.body?.basePath
    const base = String(baseInput ?? '').trim() ? assertSafePath('basePath', baseInput) : os.homedir()
    const resolvedBase = path.resolve(base)
    try {
      await fsPromises.access(resolvedBase, fs.constants.W_OK)
    } catch {
      return res.status(400).json({ error: `Location is not writable or does not exist: ${resolvedBase}` })
    }
    const rootDir = path.join(resolvedBase, 'ngs_data')
    const alreadyExisted = fs.existsSync(rootDir)
    if (!alreadyExisted) {
      await fsPromises.mkdir(rootDir, { recursive: true })
    }
    writeAppConfig({ rootDir })
    return res.json({ rootDir, created: !alreadyExisted, alreadyExisted })
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message })
  }
})

/** Reject folder names that could escape the parent dir or hit reserved/invalid characters. */
function sanitizeFolderName(name) {
  const v = String(name ?? '').trim()
  if (!v) {
    const err = new Error('Folder name is required')
    err.status = 400
    throw err
  }
  if (v === '.' || v === '..' || /[\\/:*?"<>|\r\n\0]/.test(v)) {
    const err = new Error('Folder name must not contain path separators or : * ? " < > |')
    err.status = 400
    throw err
  }
  // BBTools' bbduk.sh rebuilds its java command line via `eval`, which loses argument quoting
  // and splits any path containing a space — so folder names must not contain whitespace.
  return v.replace(/\s+/g, '_')
}

/** Immediate subdirectories of a given dir (e.g. per-patient folders under the ngs_data root). */
app.get('/api/setup/subdirs', async (req, res) => {
  try {
    const rawDir = assertSafePath('dir', req.query?.dir)
    const dir = process.platform !== 'win32' ? rawDir.replace(/\\/g, '/') : rawDir
    const resolved = path.resolve(dir)
    let entries
    try {
      entries = await fsPromises.readdir(resolved, { withFileTypes: true })
    } catch {
      return res.json({ folders: [] })
    }
    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
    return res.json({ folders })
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message })
  }
})

/** Create a named subdirectory under dir (e.g. a new patient folder under the ngs_data root). */
app.post('/api/setup/subdirs', async (req, res) => {
  try {
    const rawDir = assertSafePath('dir', req.body?.dir)
    const dir = process.platform !== 'win32' ? rawDir.replace(/\\/g, '/') : rawDir
    const name = sanitizeFolderName(req.body?.name)
    const resolvedDir = path.resolve(dir)
    try {
      await fsPromises.access(resolvedDir, fs.constants.W_OK)
    } catch {
      return res.status(400).json({ error: `Location is not writable or does not exist: ${resolvedDir}` })
    }
    const target = path.join(resolvedDir, name)
    const alreadyExisted = fs.existsSync(target)
    if (!alreadyExisted) {
      await fsPromises.mkdir(target, { recursive: true })
    }
    return res.json({ folder: name, path: target, created: !alreadyExisted, alreadyExisted })
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message })
  }
})

/** Check if a file exists on disk (used by DownstreamAnalysis to check for annotated_variants.vcf). */
app.get('/api/setup/file-exists', async (req, res) => {
  try {
    const rawPath = assertSafePath('path', req.query?.path)
    const p = process.platform !== 'win32' ? rawPath.replace(/\\/g, '/') : rawPath
    const resolved = path.resolve(p)
    try {
      await fsPromises.access(resolved, fs.constants.R_OK)
      return res.json({ exists: true, path: resolved })
    } catch {
      return res.json({ exists: false, path: resolved })
    }
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message })
  }
})

app.post('/api/qc/run', async (req, res) => {
  const fastqcDir = process.env.FASTQC_DIR?.trim()
  if (!fastqcDir) {
    return res.status(500).json({
      error:
        'Set environment variable FASTQC_DIR to the root of your cloned FastQC project (folder containing bin and jars).',
    })
  }

  let resolvedFastqc
  try {
    resolvedFastqc = path.resolve(fastqcDir)
    await fsPromises.access(resolvedFastqc, fs.constants.R_OK)
  } catch {
    return res.status(500).json({ error: `FASTQC_DIR is not readable: ${fastqcDir}` })
  }

  // Accept either inputPaths (array) or legacy inputPath (string)
  const rawPaths = req.body?.inputPaths ?? (req.body?.inputPath ? [req.body.inputPath] : [])
  const trimmedPaths = rawPaths.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)
  if (trimmedPaths.length === 0) {
    return res.status(400).json({ error: 'inputPaths is required (array of absolute paths to FastQC-supported input files).' })
  }

  const patientDirRaw = req.body?.patientDir
  // Convert Windows backslashes to forward slashes for cross‑platform compatibility
  const patientDirNorm = typeof patientDirRaw === 'string' ? patientDirRaw.replace(/\\/g, '/') : patientDirRaw
  if (!String(patientDirNorm ?? '').trim()) {
    return res.status(400).json({ error: 'patientDir is required. Select or create a patient folder before running FastQC.' })
  }
  let patientDir
  try {
    patientDir = path.resolve(assertSafePath('patientDir', patientDirNorm))
    await fsPromises.access(patientDir, fs.constants.W_OK)
  } catch {
    return res.status(400).json({ error: `Patient folder is not writable or does not exist: ${patientDirRaw}` })
  }

  const resolvedInputs = []
  for (const inputPath of trimmedPaths) {
    try {
      const resolved = path.resolve(inputPath)
      await fsPromises.access(resolved, fs.constants.R_OK)
      resolvedInputs.push(resolved)
    } catch {
      return res.status(400).json({ error: `Input file not found or not readable: ${inputPath}` })
    }
  }

  // Copy each input into the patient folder (skip if it's already located there)
  const copiedInputs = []
  try {
    for (const resolved of resolvedInputs) {
      const dest = path.join(patientDir, path.basename(resolved))
      if (path.resolve(dest) !== resolved) {
        await fsPromises.copyFile(resolved, dest)
      }
      copiedInputs.push(dest)
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not copy input file(s) into the patient folder', detail: e.message })
  }

  // Save output into a quality_control subfolder under the patient folder
  const outDir = path.join(patientDir, 'quality_control')
  try {
    await fsPromises.mkdir(outDir, { recursive: true })
  } catch (e) {
    return res.status(500).json({ error: `Could not create output folder: ${outDir}`, detail: e.message })
  }

  try {
    await runFastqc({
      fastqcDir: resolvedFastqc,
      inputPaths: copiedInputs,
      outDir,
    })
  } catch (e) {
    return res.status(500).json({
      error: 'FastQC failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }

  try {
    const entries = await fsPromises.readdir(outDir)
    if (entries.length === 0) {
      return res.status(500).json({ error: 'FastQC produced no files in the output directory.' })
    }
    return res.json({ outDir, files: entries, copiedInputs })
  } catch {
    return res.status(500).json({ error: 'Could not read FastQC output directory.' })
  }
})

app.get('/api/qc/download-html', async (req, res) => {
  const { outDir, file } = req.query
  if (!outDir || !file) {
    return res.status(400).json({ error: 'outDir and file query parameters are required.' })
  }
  // Prevent path traversal: file must be a plain filename with no directory separators
  if (path.basename(file) !== file || !file.endsWith('.html')) {
    return res.status(400).json({ error: 'Invalid file parameter.' })
  }
  const filePath = path.join(path.resolve(outDir), file)
  // Ensure the resolved path stays inside outDir
  if (!filePath.startsWith(path.resolve(outDir) + path.sep) && filePath !== path.resolve(outDir)) {
    return res.status(400).json({ error: 'Access denied.' })
  }
  try {
    await fsPromises.access(filePath, fs.constants.R_OK)
  } catch {
    return res.status(404).json({ error: `File not found: ${file}` })
  }
  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`)
  const stream = fs.createReadStream(filePath)
  stream.on('error', () => res.status(500).end())
  stream.pipe(res)
})

app.listen(PORT, () => {
  console.log(`NGS API listening on http://localhost:${PORT}`)
  if (!process.env.FASTQC_DIR) {
    console.warn('Warning: FASTQC_DIR is not set. Quality control runs will fail until you set it.')
  }
  if (!process.env.BBMAP_DIR) {
    console.warn('Warning: BBMAP_DIR is not set. Read trimming (BBDuk) will fail until you set it.')
  }
  if (useWslForAlignment()) {
    console.log(
      'WSL shell tools: bash -ilc + optional ALIGN_WSL_PROLOGUE (e.g. conda activate vep_env). Set VEP_CMD if `vep` is not on PATH.',
    )
  }
})
