import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRootDir } from '../RootDirContext.jsx'

/** With conda run, `vep` on that env’s PATH is enough */
const defaultVepCmd = 'vep'

const CACHE_MKDIR = `mkdir -p ~/.vep
cd ~/.vep`

const CACHE_WGET = `wget -c https://ftp.ensembl.org/pub/release-115/variation/indexed_vep_cache/homo_sapiens_vep_115_GRCh38.tar.gz`

const CACHE_EXTRACT = `cd ~/.vep
tar -xzf homo_sapiens_vep_115_GRCh38.tar.gz`

function copyToClipboard(text, setCopied) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  })
}

/** Windows absolute path → WSL /mnt/<drive> form (e.g. D:\a\b → /mnt/d/a/b). Unchanged otherwise. */
function toWslPath(winPath) {
  const p = String(winPath ?? '').trim()
  if (!p) return ''
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p)
  if (!m) return p.replace(/\\/g, '/')
  const rest = m[2].replace(/\\/g, '/')
  return `/mnt/${m[1].toLowerCase()}/${rest}`
}

export function VariantAnnotationPanel() {
  const { rootDir, selectedPatient: selectedFolder, setSelectedPatient: setSelectedFolder } = useRootDir()
  const [vepCmd, setVepCmd] = useState(defaultVepCmd)
  const [vepCondaEnv, setVepCondaEnv] = useState('vep_env')
  const [inputVcf, setInputVcf] = useState('')
  const [outputVcf, setOutputVcf] = useState('')
  const [fastaPath, setFastaPath] = useState('')
  const [fork, setFork] = useState('4')

  const [runLoading, setRunLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const [folders, setFolders] = useState([])
  const [loadingFolders, setLoadingFolders] = useState(false)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderError, setFolderError] = useState(null)

  const loadFolders = useCallback(async () => {
    if (!rootDir) {
      setFolders([])
      return
    }
    setLoadingFolders(true)
    setFolderError(null)
    try {
      const res = await fetch(`/api/setup/subdirs?dir=${encodeURIComponent(rootDir)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setFolders(data.folders || [])
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingFolders(false)
    }
  }, [rootDir])

  useEffect(() => {
    loadFolders()
  }, [loadFolders])

  const createFolder = useCallback(async () => {
    const name = newFolderName.trim()
    if (!name || !rootDir) return
    setCreatingFolder(true)
    setFolderError(null)
    try {
      const res = await fetch('/api/setup/subdirs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: rootDir, name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setNewFolderName('')
      setShowNewFolder(false)
      setSelectedFolder(data.folder)
      await loadFolders()
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreatingFolder(false)
    }
  }, [newFolderName, rootDir, loadFolders, setSelectedFolder])

  const getPatientDir = useCallback(() => {
    if (!rootDir || !selectedFolder) return ''
    return `${rootDir.replace(/[\\/]+$/, '')}/${selectedFolder}`
  }, [rootDir, selectedFolder])

  // Auto-fill from the selected patient: input comes from variant_calling, output goes to a new
  // variant_annotation folder, reference defaults to ~/hg38.fa.
  useEffect(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return
    const wsl = toWslPath(patientDir)
    setInputVcf(`${wsl}/variant_calling/variants.vcf.gz`)
    setOutputVcf(`${wsl}/variant_annotation/annotated_variants.vcf`)
    setFastaPath('~/hg38.fa')
  }, [getPatientDir])

  // Create the variant_annotation folder under the patient folder as soon as it's selected.
  useEffect(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return
    let cancelled = false
    fetch('/api/setup/subdirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: patientDir, name: 'variant_annotation' }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.error) setFolderError(data.error)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [getPatientDir])

  const vepPreview = useMemo(() => {
    const v = vepCmd.trim() || defaultVepCmd
    const env = vepCondaEnv.trim()
    const i = inputVcf.trim()
    const o = outputVcf.trim()
    const f = fastaPath.trim()
    const fk = fork.trim() || '4'
    const inner = !i || !o || !f
      ? [
          `${v} --cache --offline --fork ${fk} \\`,
          '  -i ~/variants.vcf.gz \\',
          '  -o ~/annotated_variants.vcf \\',
          '  --vcf --symbol --terms SO --hgvs --protein --canonical \\',
          '  --fasta ~/hg38.fa \\',
          '  --force_overwrite',
        ].join('\n')
      : [
          `${v} --cache --offline --fork ${fk} \\`,
          `  -i ${i} \\`,
          `  -o ${o} \\`,
          '  --vcf --symbol --terms SO --hgvs --protein --canonical \\',
          `  --fasta ${f} \\`,
          '  --force_overwrite',
        ].join('\n')
    if (!env) return inner
    const collapsed = inner
      .split('\n')
      .map((line) => line.replace(/\\$/, '').trim())
      .filter(Boolean)
      .join(' ')
    return `conda run -n ${env} --no-capture-output ${collapsed}`
  }, [vepCmd, vepCondaEnv, inputVcf, outputVcf, fastaPath, fork])

  const runVep = useCallback(async () => {
    const i = inputVcf.trim()
    const o = outputVcf.trim()
    const f = fastaPath.trim()
    const v = vepCmd.trim() || defaultVepCmd
    const fk = fork.trim() ? Number.parseInt(fork.trim(), 10) : 4
    if (!i || !o || !f) {
      return
    }
    if (!Number.isInteger(fk) || fk < 1 || fk > 16) {
      return
    }
    setRunLoading(true)
    try {
      const res = await fetch('/api/variant-annotation/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vepCmd: v,
          vepCondaEnv: vepCondaEnv.trim() || undefined,
          inputVcf: i,
          outputVcf: o,
          fastaPath: f,
          fork: fk,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          data.detail ? `${data.error || 'Error'}: ${data.detail}` : data.error || res.statusText,
        )
      }
    } catch {
      // Suppress UI output/error boxes for this step.
    } finally {
      setRunLoading(false)
    }
  }, [vepCmd, vepCondaEnv, inputVcf, outputVcf, fastaPath, fork])

  const canRun =
    Boolean(inputVcf.trim() && outputVcf.trim() && fastaPath.trim()) && !runLoading

  return (
    <div className="qc-panel align-panel">
      <p className="qc-lead">
        <strong>Variant annotation</strong> with <strong>Ensembl VEP</strong> in WSL, using a local
        cache (<code>--cache --offline</code>). Download and extract the cache under{' '}
        <code>~/.vep</code> first, then run VEP (often from a conda env such as{' '}
        <code>vep_env</code>).
      </p>

      <section className="align-section">
        <h3 className="qc-help-title">1. Download and install the VEP cache (manual, one time)</h3>
        <p className="qc-hint">
          <strong>Go to the VEP cache folder</strong>
        </p>
        <pre className="qc-cmd align-pre">{CACHE_MKDIR}</pre>
        <button
          type="button"
          className="qc-run align-copy"
          onClick={() => copyToClipboard(CACHE_MKDIR, setCopied)}
        >
          Copy
        </button>
        <p className="qc-hint">
          <strong>Download</strong> (GRCh38 / release 115)
        </p>
        <pre className="qc-cmd align-pre">{CACHE_WGET}</pre>
        <button
          type="button"
          className="qc-run align-copy"
          onClick={() => copyToClipboard(CACHE_WGET, setCopied)}
        >
          Copy
        </button>
        <p className="qc-hint">
          <strong>Extract</strong>
        </p>
        <pre className="qc-cmd align-pre">{CACHE_EXTRACT}</pre>
        <button
          type="button"
          className="qc-run align-copy"
          onClick={() => copyToClipboard(CACHE_EXTRACT, setCopied)}
        >
          Copy
        </button>
      </section>

      <section className="align-section">
        <h3 className="qc-help-title">2. Conda env (recommended for API runs)</h3>
        <p className="qc-hint">
          <code>conda activate vep_env</code> then{' '}
          <code className="qc-cmd align-cmd-inline">conda install -y -c bioconda perl-dbi</code>
        </p>
        <p className="qc-hint">
          Optional: set <code>CONDA_EXE=~/miniconda3/bin/conda</code> and{' '}
          <code>VEP_CONDA_ENV=vep_env</code> in <code>backend/.env</code>. Use full path to{' '}
          <code>vep</code> as <code>VEP_CMD</code> if you leave &quot;Conda env&quot; empty.
        </p>
      </section>

      <section className="align-section">
        <h3 className="qc-help-title">3. Run VEP</h3>
        <p className="qc-hint">
          Same flags as a typical offline run: <code>--vcf --symbol --terms SO --hgvs --protein --canonical</code>,{' '}
          <code>--fasta</code>, <code>--force_overwrite</code>.
        </p>

        <div className="qc-field">
          <label>Patient folder (under ngs_data root)</label>
          {!rootDir ? (
            <p className="qc-hint">
              Set up the root directory in the <strong>Overview &amp; Setup</strong> page first.
            </p>
          ) : (
            <>
              <div className="qc-path-row">
                <select
                  className="qc-input"
                  value={selectedFolder}
                  onChange={(e) => setSelectedFolder(e.target.value)}
                  disabled={loadingFolders || creatingFolder}
                >
                  <option value="">
                    {loadingFolders ? 'Loading folders…' : '— None (browse anywhere) —'}
                  </option>
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="qc-browse"
                  onClick={() => setShowNewFolder((v) => !v)}
                  disabled={creatingFolder}
                >
                  {showNewFolder ? 'Cancel' : '+ New folder'}
                </button>
              </div>
              {showNewFolder && (
                <div className="qc-path-row">
                  <input
                    type="text"
                    className="qc-input"
                    placeholder="e.g. John_Doe-P12345"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={creatingFolder}
                  />
                  <button
                    type="button"
                    className="qc-browse"
                    onClick={createFolder}
                    disabled={creatingFolder || !newFolderName.trim()}
                  >
                    {creatingFolder ? 'Creating…' : 'Create'}
                  </button>
                </div>
              )}
              {folderError && <div className="qc-error">{folderError}</div>}
            </>
          )}
          <p className="qc-hint">
            Selecting a patient creates a <code>variant_annotation</code> folder inside it (if
            missing) and fills in Input VCF, Output VCF and Reference FASTA below.
          </p>
        </div>

        <div className="qc-field">
          <label htmlFor="va-conda-env">Conda env for <code>conda run</code> (leave empty to skip)</label>
          <input
            id="va-conda-env"
            type="text"
            className="qc-input"
            placeholder="vep_env"
            value={vepCondaEnv}
            onChange={(e) => setVepCondaEnv(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
        </div>

        <div className="qc-field">
          <label htmlFor="va-vep"><code>vep</code> command (or full path)</label>
          <input
            id="va-vep"
            type="text"
            className="qc-input"
            placeholder="vep"
            value={vepCmd}
            onChange={(e) => setVepCmd(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
          <p className="qc-hint">
            With a conda env set, <code>vep</code> alone is usually enough. Otherwise use e.g.{' '}
            <code>~/miniconda3/envs/vep_env/bin/vep</code>.
          </p>
        </div>

        <div className="qc-field">
          <label htmlFor="va-in">Input VCF (-i)</label>
          <input
            id="va-in"
            type="text"
            className="qc-input"
            placeholder="~/variants.vcf.gz"
            value={inputVcf}
            onChange={(e) => setInputVcf(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
        </div>

        <div className="qc-field">
          <label htmlFor="va-out">Output annotated VCF (-o)</label>
          <input
            id="va-out"
            type="text"
            className="qc-input"
            placeholder="~/annotated_variants.vcf"
            value={outputVcf}
            onChange={(e) => setOutputVcf(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
        </div>

        <div className="qc-field">
          <label htmlFor="va-fa">Reference FASTA (--fasta)</label>
          <input
            id="va-fa"
            type="text"
            className="qc-input"
            placeholder="~/hg38.fa"
            value={fastaPath}
            onChange={(e) => setFastaPath(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
        </div>

        <div className="qc-field">
          <label htmlFor="va-fork">Parallel forks (--fork)</label>
          <input
            id="va-fork"
            type="text"
            className="qc-input"
            placeholder="4"
            value={fork}
            onChange={(e) => setFork(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
        </div>

        <pre className="qc-cmd align-pre">{vepPreview}</pre>

        <div className="qc-actions align-actions-row">
          <button type="button" className="qc-run" onClick={runVep} disabled={!canRun}>
            {runLoading ? 'Running VEP…' : 'Run VEP'}
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={() => copyToClipboard(vepPreview, setCopied)}
            disabled={runLoading}
          >
            Copy command
          </button>
        </div>

        {copied ? (
          <p className="qc-hint align-copied" role="status">
            Copied to clipboard.
          </p>
        ) : null}
      </section>
    </div>
  )
}
