import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRootDir } from '../RootDirContext.jsx'
import { FilePickerModal } from './FilePickerModal.jsx'

/** Matches a typical WSL home layout: cloned bwa build under ~/bwa/bwa */
// const defaultBwa = '~/bwa/bwa'
const defaultBwa = 'bwa'
const DEFAULT_REF_PATH = '/home/ngs/hg38.fa'

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

export function AlignmentPanel() {
  const { rootDir, selectedPatient: selectedFolder, setSelectedPatient: setSelectedFolder } = useRootDir()
  const [bwaCmd, setBwaCmd] = useState(defaultBwa)
  const [refPath, setRefPath] = useState(DEFAULT_REF_PATH)
  const [fastqPath, setFastqPath] = useState('')
  const [indexBamPath, setIndexBamPath] = useState('')

  const [browsing, setBrowsing] = useState(false)
  const [showFileModal, setShowFileModal] = useState(false)
  const [alignLoading, setAlignLoading] = useState(false)
  const [alignError, setAlignError] = useState(null)
  const [alignResult, setAlignResult] = useState(null)

  const [indexingRef, setIndexingRef] = useState(false)
  const [indexRefResult, setIndexRefResult] = useState(null)
  const [indexRefError, setIndexRefError] = useState(null)
  const [showRefModal, setShowRefModal] = useState(false)
  const [browsingRef, setBrowsingRef] = useState(false)

  const [indexLoading, setIndexLoading] = useState(false)

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
  }, [newFolderName, rootDir, loadFolders])

  const getPatientDir = useCallback(() => {
    if (!rootDir || !selectedFolder) return ''
    return `${rootDir.replace(/[\\/]+$/, '')}/${selectedFolder}`
  }, [rootDir, selectedFolder])

  const getOutBamPreview = useCallback(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return ''
    return `${toWslPath(patientDir)}/alignment/aligned_sorted.bam`
  }, [getPatientDir])

  // Keep "Path to sorted BAM" in sync with the computed alignment output as soon as a FASTQ is picked.
  useEffect(() => {
    if (!fastqPath.trim()) return
    const preview = getOutBamPreview()
    if (preview) setIndexBamPath(preview)
  }, [fastqPath, getOutBamPreview])

  const pickFastqFile = async () => {
    setAlignError(null)
    setBrowsing(true)
    try {
      const baseDir = fastqPath.trim() || getPatientDir() || rootDir
      const res = await fetch('/api/file-picker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: baseDir }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.filePath) {
        setFastqPath(toWslPath(data.filePath))
        return
      }
      if (data?.cancelled) {
        return
      }
      setShowFileModal(true)
    } catch {
      setShowFileModal(true)
    } finally {
      setBrowsing(false)
    }
  }

  const pickRefFile = async () => {
    setIndexRefError(null)
    setBrowsingRef(true)
    try {
      const defaultDir = refPath.trim() || '/home/ngs'
      const res = await fetch('/api/file-picker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: defaultDir }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.filePath) {
        setRefPath(toWslPath(data.filePath))
        return
      }
      if (data?.cancelled) {
        return
      }
      setShowRefModal(true)
    } catch {
      setShowRefModal(true)
    } finally {
      setBrowsingRef(false)
    }
  }

  const indexRefCmd = useMemo(() => `${bwaCmd.trim() || 'bwa'} index ${refPath.trim() || DEFAULT_REF_PATH}`, [bwaCmd, refPath])

  const runIndexRef = useCallback(async () => {
    setIndexRefError(null)
    setIndexRefResult(null)
    setIndexingRef(true)
    try {
      const bwa = bwaCmd.trim() || 'bwa'
      const ref = refPath.trim() || DEFAULT_REF_PATH
      const res = await fetch('/api/alignment/index-ref', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bwaCmd: bwa,
          refPath: ref,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          data.detail ? `${data.error || 'Error'}: ${data.detail}` : data.error || res.statusText,
        )
      }
      setIndexRefResult(data)
    } catch (e) {
      setIndexRefError(e instanceof Error ? e.message : String(e))
    } finally {
      setIndexingRef(false)
    }
  }, [bwaCmd, refPath])

  const generatedAlignment = useMemo(() => {
    const f = fastqPath.trim()
    const o = getOutBamPreview()
    const b = bwaCmd.trim() || 'bwa'
    const r = refPath.trim() || DEFAULT_REF_PATH
    if (!f || !o) {
      return [
        `${b} mem ${r} ~/cleaned.fastq \\`,
        '| samtools view -Sb - \\',
        '| samtools sort -o ~/aligned_sorted.bam',
      ].join('\n')
    }
    return [`${b} mem ${r} ${f} \\`, '| samtools view -Sb - \\', `| samtools sort -o ${o}`].join(
      '\n',
    )
  }, [bwaCmd, fastqPath, getOutBamPreview, refPath])

  const indexBamCmd = useMemo(() => {
    const p = indexBamPath.trim() || getOutBamPreview()
    if (!p) return 'samtools index <path_to_aligned_sorted.bam>'
    return `samtools index ${p}`
  }, [indexBamPath, getOutBamPreview])

  const runAlignment = useCallback(async () => {
    setAlignError(null)
    setAlignResult(null)
    const fq = fastqPath.trim()
    const patientDir = getPatientDir()
    const bwa = bwaCmd.trim() || 'bwa'
    if (!fq) {
      setAlignError('Select the cleaned FASTQ file.')
      return
    }
    if (!patientDir) {
      setAlignError('Select or create a patient folder before running alignment.')
      return
    }
    setAlignLoading(true)
    try {
      const res = await fetch('/api/alignment/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bwaCmd: bwa,
          refPath: refPath.trim() || DEFAULT_REF_PATH,
          fastqPath: fq,
          patientDir,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          data.detail ? `${data.error || 'Error'}: ${data.detail}` : data.error || res.statusText,
        )
      }
      setAlignResult(data)
      if (data.outBamPath) setIndexBamPath(data.outBamPath)
    } catch (e) {
      setAlignError(e instanceof Error ? e.message : String(e))
    } finally {
      setAlignLoading(false)
    }
  }, [bwaCmd, fastqPath, getPatientDir, refPath])

  const runIndexBam = useCallback(async () => {
    const bam = indexBamPath.trim() || getOutBamPreview()
    if (!bam) {
      return
    }
    setIndexLoading(true)
    try {
      const res = await fetch('/api/alignment/index-bam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bamPath: bam }),
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
      setIndexLoading(false)
    }
  }, [indexBamPath, getOutBamPreview])

  const useOutputAsIndexPath = useCallback(() => {
    const o = getOutBamPreview()
    if (o) setIndexBamPath(o)
  }, [getOutBamPreview])

  const canRunAlign = Boolean(fastqPath.trim() && selectedFolder) && !alignLoading
  const canRunIndex = Boolean((indexBamPath.trim() || getOutBamPreview()) && !indexLoading)

  return (
    <div className="qc-panel align-panel">
      <p className="qc-lead">
        <strong>Objective:</strong> Align cleaned reads to hg38 with <strong>BWA-MEM</strong> and{' '}
        <strong>Samtools</strong>. On Windows, the API runs commands in <strong>WSL</strong> (
        <code>wsl.exe</code>). You can use{' '}
        <code>~/…</code> paths (e.g. <code>~/bwa/bwa</code>, <code>~/hg38.fa</code>)—they expand to
        your WSL home.
      </p>

      <section className="align-section">
        <h3 className="qc-help-title">1. Reference genome indexing (bwa index)</h3>
        <p className="qc-hint">
          Initially, BWA must index the reference FASTA genome before alignments can be run. Run this once for your reference FASTA (creates <code>.amb</code>, <code>.ann</code>, <code>.bwt</code>, <code>.pac</code>, <code>.sa</code> files alongside the FASTA).
        </p>

        <div className="qc-field">
          <label htmlFor="align-ref-path">Reference FASTA path</label>
          <div className="qc-path-row">
            <input
              id="align-ref-path"
              type="text"
              className="qc-input"
              value={refPath}
              onChange={(e) => setRefPath(e.target.value)}
              placeholder="/home/ngs/hg38.fa"
              autoComplete="off"
              spellCheck={false}
              disabled={indexingRef || alignLoading || browsingRef}
            />
            <button
              type="button"
              className="qc-browse"
              onClick={pickRefFile}
              disabled={indexingRef || alignLoading || browsingRef}
              title="Browse for Reference FASTA file"
            >
              Browse…
            </button>
          </div>

          <FilePickerModal
            isOpen={showRefModal}
            initialPath={refPath.trim() || '/home/ngs'}
            onSelect={(selected) => setRefPath(toWslPath(selected))}
            onClose={() => setShowRefModal(false)}
            title="Select Reference FASTA File"
            allowedExtensions={['.fa', '.fasta', '.fna', '.gz']}
            filterLabel="FASTA files only (*.fa, *.fasta, *.fna, *.gz)"
          />
        </div>

        <div className="qc-field">
          <label>Command preview</label>
          <pre className="qc-cmd">{indexRefCmd}</pre>
        </div>

        <div className="qc-actions">
          <button
            type="button"
            className="qc-run"
            onClick={runIndexRef}
            disabled={indexingRef || !refPath.trim()}
          >
            {indexingRef ? 'Indexing reference… (this may take several minutes)' : 'Run BWA Index'}
          </button>
        </div>

        {indexRefResult && (
          <div className="qc-success">
            <strong>Reference indexing complete!</strong>
            <p>Indexed reference: <code>{refPath}</code></p>
            {indexRefResult.stdout && <pre className="qc-cmd">{indexRefResult.stdout}</pre>}
          </div>
        )}

        {indexRefError && <div className="qc-error">{indexRefError}</div>}
      </section>

      <section className="align-section">
        <h3 className="qc-help-title">2. Run alignment</h3>
        <p className="qc-hint">
          <strong>Paths:</strong> Use the same paths WSL Linux would use—<code>~/…</code> or{' '}
          <code>/home/yourname/…</code>—not Windows paths like <code>C:\…</code>. The pipeline runs
          inside WSL, so inputs must be where Linux can read them (your WSL home is fine).{' '}
          </p>
          <p className="qc-hint">
          <strong>Output:</strong> The sorted BAM is written to an <strong>alignment</strong> folder
          under the selected patient folder, named <code>aligned_sorted.bam</code>.
        </p>
        <p className="qc-hint">
          This executes:{' '}
          <code className="qc-cmd align-cmd-inline">
            bwa mem → samtools view -Sb → samtools sort -o
          </code>
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
        </div>

        <div className="qc-field">
          <label htmlFor="align-bwa">BWA command</label>
          <input
            id="align-bwa"
            type="text"
            className="qc-input"
            placeholder="bwa"
            value={bwaCmd}
            onChange={(e) => setBwaCmd(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={alignLoading}
          />
          <p className="qc-hint">
            Use <code>bwa</code> if you have BWA downloaded on your home. Otherwise the full path from{' '}
            <code>which bwa</code>.
          </p>
        </div>

        <div className="qc-field">
          <label>Path to reference genome (hg38.fa)</label>
          <div className="qc-path-row">
            <input
              type="text"
              className="qc-input"
              value={refPath}
              onChange={(e) => setRefPath(e.target.value)}
              placeholder="/home/ngs/hg38.fa"
              disabled={alignLoading || indexingRef || browsingRef}
            />
            <button
              type="button"
              className="qc-browse"
              onClick={pickRefFile}
              disabled={alignLoading || indexingRef || browsingRef}
              title="Browse for Reference FASTA file"
            >
              Browse…
            </button>
          </div>
        </div>

        <div className="qc-field">
          <label htmlFor="align-fastq">Path to cleaned FASTQ</label>
          <div className="qc-path-row">
            <input
              id="align-fastq"
              type="text"
              className="qc-input"
              placeholder="/mnt/d/ngs_data/<patient>/trimming/cleaned_sample.fastq"
              value={fastqPath}
              onChange={(e) => setFastqPath(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={alignLoading || browsing}
            />
            <button
              type="button"
              className="qc-browse"
              onClick={pickFastqFile}
              disabled={alignLoading || browsing}
              title="Browse for file"
            >
              Browse…
            </button>
          </div>
          <p className="qc-hint">
            Browsing converts the Windows path to WSL form (e.g. <code>/mnt/d/abc</code>). You can
            also type a WSL path (<code>~/…</code>) directly.
          </p>

          <FilePickerModal
            isOpen={showFileModal}
            initialPath={fastqPath.trim() || getPatientDir() || rootDir}
            onSelect={(selected) => setFastqPath(toWslPath(selected))}
            onClose={() => setShowFileModal(false)}
            title="Select Input FASTQ File"
          />
        </div>

        <div className="qc-field">
          <label>Path for sorted BAM output</label>
          <input
            type="text"
            className="qc-input"
            value={getOutBamPreview()}
            placeholder="Select a patient folder to see the output path"
            disabled
            readOnly
          />
        </div>

        <pre className="qc-cmd align-pre">{generatedAlignment}</pre>

        <div className="qc-actions align-actions-row">
          <button
            type="button"
            className="qc-run"
            onClick={runAlignment}
            disabled={!canRunAlign}
          >
            {alignLoading ? 'Running alignment…' : 'Run alignment'}
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={() => copyToClipboard(generatedAlignment, setCopied)}
            disabled={alignLoading}
          >
            Copy command
          </button>
        </div>
        {!selectedFolder && (
          <p className="qc-hint">Select or create a patient folder above to enable this.</p>
        )}

        {alignResult && (
          <div className="qc-success">
            <strong>Alignment complete.</strong>
            <p>
              Output written to: <code>{alignResult.outBamPath}</code>
            </p>
          </div>
        )}

        {alignError && <div className="qc-error">{alignError}</div>}

        {copied ? (
          <p className="qc-hint align-copied" role="status">
            Copied to clipboard.
          </p>
        ) : null}
      </section>

      <section className="align-section">
        <h3 className="qc-help-title">Index sorted BAM</h3>
        <p className="qc-hint">
          Path to the sorted BAM file (usually the same as the output path above). Produces{' '}
          <code>.bai</code> next to the BAM.
        </p>

        <div className="qc-field">
          <label htmlFor="align-index-bam">Path to sorted BAM</label>
          <input
            id="align-index-bam"
            type="text"
            className="qc-input"
            placeholder="~/aligned_sorted.bam"
            value={indexBamPath}
            onChange={(e) => setIndexBamPath(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={indexLoading}
          />
        </div>

        <pre className="qc-cmd align-pre">{indexBamCmd}</pre>

        <div className="qc-actions align-actions-row">
          <button type="button" className="qc-run" onClick={runIndexBam} disabled={!canRunIndex}>
            {indexLoading ? 'Indexing…' : 'Index BAM'}
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={useOutputAsIndexPath}
            disabled={indexLoading || !getOutBamPreview()}
          >
            Use output BAM path
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={() => copyToClipboard(indexBamCmd, setCopied)}
            disabled={indexLoading}
          >
            Copy command
          </button>
        </div>

      </section>
    </div>
  )
}
