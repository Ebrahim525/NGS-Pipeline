import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRootDir } from '../RootDirContext.jsx'
import { FilePickerModal } from './FilePickerModal.jsx'

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

export function PostAlignmentPanel() {
  const { rootDir, selectedPatient: selectedFolder, setSelectedPatient: setSelectedFolder } = useRootDir()
  const [inputBam, setInputBam] = useState('')
  const [indexBamPath, setIndexBamPath] = useState('')

  const [browsing, setBrowsing] = useState(false)
  const [showFileModal, setShowFileModal] = useState(false)
  const [mdLoading, setMdLoading] = useState(false)
  const [mdError, setMdError] = useState(null)
  const [mdResult, setMdResult] = useState(null)

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

  const getOutputBamPreview = useCallback(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return ''
    return `${toWslPath(patientDir)}/post_alignment/dedup.bam`
  }, [getPatientDir])

  const getMetricsPreview = useCallback(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return ''
    return `${toWslPath(patientDir)}/post_alignment/dup_metrics.txt`
  }, [getPatientDir])

  // Keep "Path to dedup BAM" in sync with the computed output as soon as an input BAM is picked.
  useEffect(() => {
    if (!inputBam.trim()) return
    const preview = getOutputBamPreview()
    if (preview) setIndexBamPath(preview)
  }, [inputBam, getOutputBamPreview])

  const pickInputBam = async () => {
    setMdError(null)
    setBrowsing(true)
    try {
      const baseDir = inputBam.trim() || getPatientDir() || rootDir
      const res = await fetch('/api/file-picker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: baseDir }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.filePath) {
        setInputBam(toWslPath(data.filePath))
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

  const markDupPreview = useMemo(() => {
    const i = inputBam.trim()
    const o = getOutputBamPreview()
    const m = getMetricsPreview()
    if (!i || !o || !m) {
      return '/usr/lib/jvm/java-17-openjdk-amd64/bin/java -jar ~/picard.jar MarkDuplicates I=~/aligned_sorted.bam O=~/dedup.bam M=~/dup_metrics.txt'
    }
    return `/usr/lib/jvm/java-17-openjdk-amd64/bin/java -jar ~/picard.jar MarkDuplicates I=${i} O=${o} M=${m}`
  }, [inputBam, getOutputBamPreview, getMetricsPreview])

  const indexCmdPreview = useMemo(() => {
    const b = indexBamPath.trim() || getOutputBamPreview()
    if (!b) return 'samtools index ~/dedup.bam'
    return `samtools index ${b}`
  }, [indexBamPath, getOutputBamPreview])

  const runMarkDuplicates = useCallback(async () => {
    setMdError(null)
    setMdResult(null)
    const i = inputBam.trim()
    const patientDir = getPatientDir()
    if (!i) {
      setMdError('Select the input sorted BAM file.')
      return
    }
    if (!patientDir) {
      setMdError('Select or create a patient folder before running MarkDuplicates.')
      return
    }
    setMdLoading(true)
    try {
      const res = await fetch('/api/post-alignment/mark-duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputBam: i,
          patientDir,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          data.detail ? `${data.error || 'Error'}: ${data.detail}` : data.error || res.statusText,
        )
      }
      setMdResult(data)
      if (data.outputBam) setIndexBamPath(data.outputBam)
    } catch (e) {
      setMdError(e instanceof Error ? e.message : String(e))
    } finally {
      setMdLoading(false)
    }
  }, [inputBam, getPatientDir])

  const runIndexBam = useCallback(async () => {
    const bam = indexBamPath.trim() || getOutputBamPreview()
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
  }, [indexBamPath, getOutputBamPreview])

  const useDedupForIndex = useCallback(() => {
    const o = getOutputBamPreview()
    if (o) setIndexBamPath(o)
  }, [getOutputBamPreview])

  const canRunMd = Boolean(inputBam.trim() && selectedFolder) && !mdLoading
  const canRunIndex = Boolean((indexBamPath.trim() || getOutputBamPreview()) && !indexLoading)

  return (
    <div className="qc-panel align-panel">
      <p className="qc-lead">
        <strong>Step 4 — Post-alignment:</strong> mark duplicate reads with{' '}
        <strong>Picard MarkDuplicates</strong>, then index the deduplicated BAM with{' '}
        <strong>samtools index</strong>. Set <code>PICARD_JAVA</code> and{' '}
        <code>PICARD_JAR</code> in <code>backend/.env</code> (e.g.{' '}
        <code>java -jar ~/picard.jar</code> like your WSL terminal). Select or create a patient
        folder, then choose the input BAM. Outputs are written under a{' '}
        <strong>post_alignment</strong> folder in the patient folder:{' '}
        <code>dedup.bam</code>, <code>dup_metrics.txt</code>, <code>dedup.bam.bai</code> after indexing.
      </p>

      <section className="align-section">
        <h3 className="qc-help-title">Picard jar + Java (WSL)</h3>
        <p className="qc-hint">
          Put <code>picard.jar</code> in your WSL home (e.g. <code>~/picard.jar</code>) and install
          OpenJDK 17. In <code>backend/.env</code> set <code>PICARD_JAVA</code> and{' '}
          <code>PICARD_JAR</code> to match your working terminal command.
        </p>
        <pre className="qc-cmd align-pre">
          {`# Example backend/.env (paths are WSL-style)
PICARD_JAVA=/usr/lib/jvm/java-17-openjdk-amd64/bin/java
PICARD_JAR=~/picard.jar`}
        </pre>

      </section>

      <section className="align-section">
        <h3 className="qc-help-title">Mark duplicates (Picard)</h3>
        <p className="qc-hint">
          Input is the <strong>coordinate-sorted</strong> BAM from alignment (e.g.{' '}
          <code>~/aligned_sorted.bam</code>). With <code>PICARD_JAR</code> set, the server runs{' '}
          <code>$PICARD_JAVA -jar $PICARD_JAR MarkDuplicates I=… O=… M=…</code> in WSL.
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
          <label htmlFor="pa-input-bam">Input sorted BAM (I=)</label>
          <div className="qc-path-row">
            <input
              id="pa-input-bam"
              type="text"
              className="qc-input"
              placeholder="/mnt/d/ngs_data/<patient>/alignment/aligned_sorted.bam"
              value={inputBam}
              onChange={(e) => setInputBam(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={mdLoading || browsing}
            />
            <button
              type="button"
              className="qc-browse"
              onClick={pickInputBam}
              disabled={mdLoading || browsing}
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
            initialPath={inputBam.trim() || getPatientDir() || rootDir}
            onSelect={(selected) => setInputBam(toWslPath(selected))}
            onClose={() => setShowFileModal(false)}
            title="Select Input BAM File"
          />
        </div>

        <div className="qc-field">
          <label>Output deduplicated BAM (O=)</label>
          <input
            type="text"
            className="qc-input"
            value={getOutputBamPreview()}
            placeholder="Select a patient folder to see the output path"
            disabled
            readOnly
          />
        </div>

        <div className="qc-field">
          <label>Duplicate metrics file (M=)</label>
          <input
            type="text"
            className="qc-input"
            value={getMetricsPreview()}
            placeholder="Select a patient folder to see the output path"
            disabled
            readOnly
          />
        </div>

        <pre className="qc-cmd align-pre">{markDupPreview}</pre>

        <div className="qc-actions align-actions-row">
          <button type="button" className="qc-run" onClick={runMarkDuplicates} disabled={!canRunMd}>
            {mdLoading ? 'Running Picard…' : 'Run MarkDuplicates'}
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={() => copyToClipboard(markDupPreview, setCopied)}
            disabled={mdLoading}
          >
            Copy command
          </button>
        </div>
        {!selectedFolder && (
          <p className="qc-hint">Select or create a patient folder above to enable this.</p>
        )}

        {mdResult && (
          <div className="qc-success">
            <strong>MarkDuplicates complete.</strong>
            <p>
              Output written to: <code>{mdResult.outputBam}</code>
            </p>
            <p>
              Metrics written to: <code>{mdResult.metricsPath}</code>
            </p>
          </div>
        )}

        {mdError && <div className="qc-error">{mdError}</div>}

      </section>

      <section className="align-section">
        <h3 className="qc-help-title">Index deduplicated BAM</h3>
        <p className="qc-hint">
          Run after MarkDuplicates finishes. Produces <code>dedup.bam.bai</code> beside the BAM.
        </p>

        <div className="qc-field">
          <label htmlFor="pa-index-bam">Path to dedup BAM</label>
          <input
            id="pa-index-bam"
            type="text"
            className="qc-input"
            placeholder="~/dedup.bam"
            value={indexBamPath}
            onChange={(e) => setIndexBamPath(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={indexLoading}
          />
        </div>

        <pre className="qc-cmd align-pre">{indexCmdPreview}</pre>

        <div className="qc-actions align-actions-row">
          <button type="button" className="qc-run" onClick={runIndexBam} disabled={!canRunIndex}>
            {indexLoading ? 'Indexing…' : 'Index BAM'}
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={useDedupForIndex}
            disabled={indexLoading || !getOutputBamPreview()}
          >
            Use dedup output path
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={() => copyToClipboard(indexCmdPreview, setCopied)}
            disabled={indexLoading}
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
