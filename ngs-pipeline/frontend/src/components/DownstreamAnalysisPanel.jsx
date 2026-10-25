import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRootDir } from '../RootDirContext.jsx'
import { FilePickerModal } from './FilePickerModal.jsx'

export function DownstreamAnalysisPanel() {
  const { rootDir, selectedPatient: selectedFolder, setSelectedPatient: setSelectedFolder } = useRootDir()
  const [inputVcf, setInputVcf] = useState('')
  const [outputHtml, setOutputHtml] = useState('')
  const [userEditedOutput, setUserEditedOutput] = useState(false)
  const [scriptPath, setScriptPath] = useState('')
  const [dbDir, setDbDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [showFileModal, setShowFileModal] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [log, setLog] = useState('')
  const [reportPath, setReportPath] = useState('')
  const fileInputRef = useRef(null)

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

  /** Native OS path (this step runs Python directly, not through WSL/bash). */
  const getReportDir = useCallback(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return ''
    return `${patientDir}/ngs-report`
  }, [getPatientDir])

  const getOutputHtmlFor = useCallback(
    (vcfPath) => {
      const v = String(vcfPath ?? '').trim()
      if (!v) return ''
      const base = v.split(/[\\/]/).pop()?.replace(/\.vcf$/i, '') || 'clinical'
      const reportDir = getReportDir()
      if (reportDir) return `${reportDir}/${base}_report.html`

      // If reportDir is not available, but VCF is located in .../<patient>/variant_annotation/...,
      // ensure the report goes to .../<patient>/ngs-report/<base>_report.html
      const match = v.match(/^(.*)[\\/]variant_annotation([\\/].*)?$/i)
      if (match) {
        return `${match[1]}/ngs-report/${base}_report.html`
      }
      return v.replace(/\.vcf$/i, '_report.html')
    },
    [getReportDir],
  )

  useEffect(() => {
    setUserEditedOutput(false)
  }, [selectedFolder])

  // Selecting a patient: create the ngs-report folder if missing, and auto-fill the input VCF
  // from variant_annotation if the annotated VCF was already produced there.
  useEffect(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return
    let cancelled = false

    fetch('/api/setup/subdirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: patientDir, name: 'ngs-report' }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.error) setFolderError(data.error)
      })
      .catch(() => {})

    const annotatedVcf = `${patientDir}/variant_annotation/annotated_variants.vcf`
    fetch(`/api/setup/file-exists?path=${encodeURIComponent(annotatedVcf)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.exists) return
        setInputVcf(annotatedVcf)
        if (!userEditedOutput) {
          setOutputHtml(`${patientDir}/ngs-report/annotated_variants_report.html`)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [getPatientDir, userEditedOutput])

  const handleVcfFileSelect = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setUploading(true)
    setError(null)
    try {
      const text = await file.text()
      const res = await fetch('/api/upload-vcf', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'x-filename': file.name },
        body: text,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || data.error || res.statusText)
      const savedPath = data.savedPath
      setInputVcf(savedPath)
      if (!userEditedOutput) {
        setOutputHtml(getOutputHtmlFor(savedPath))
      }
    } catch (err) {
      setError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setUploading(false)
    }
  }, [getOutputHtmlFor, userEditedOutput])

  const pickVcfFile = async () => {
    setError(null)
    setBrowsing(true)
    try {
      const patientDir = getPatientDir()
      const defaultDir = inputVcf.trim()
        ? inputVcf.trim()
        : patientDir
          ? `${patientDir}/variant_annotation`
          : rootDir || ''
      const res = await fetch('/api/file-picker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: defaultDir }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.filePath) {
        setInputVcf(data.filePath)
        if (!userEditedOutput) {
          setOutputHtml(getOutputHtmlFor(data.filePath))
        }
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

  const commandPreview = useMemo(() => {
    const i = inputVcf.trim() || '/path/to/input.vcf'
    const o = outputHtml.trim() || (inputVcf.trim() ? getOutputHtmlFor(inputVcf.trim()) : '/path/to/ngs-report/annotated_variants_report.html')
    return `python vcf_report_generator.py "${i}" --output "${o}"`
  }, [inputVcf, outputHtml, getOutputHtmlFor])

  const runReport = useCallback(async () => {
    setError(null)
    setLog('')
    setReportPath('')
    const i = inputVcf.trim()
    const o = outputHtml.trim() || (i ? getOutputHtmlFor(i) : '')
    if (!i || !o) {
      setError('Enter both Input VCF path and Output HTML path.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/downstream/civic-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputVcf: i,
          outputHtml: o,
          scriptPath: scriptPath.trim() || undefined,
          dbDir: dbDir.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          data.detail ? `${data.error || 'Error'}: ${data.detail}` : data.error || res.statusText,
        )
      }
      const parts = [
        data.command ? `Command:\n${data.command}` : '',
        data.stdout ? `\nSTDOUT:\n${data.stdout}` : '',
        data.stderr ? `\nSTDERR:\n${data.stderr}` : '',
        data.outputHtml ? `\nGenerated HTML:\n${data.outputHtml}` : '',
      ].filter(Boolean)
      setLog(parts.join('\n').trim() || 'Report generated successfully.')
      if (data.outputHtml) setReportPath(data.outputHtml)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [dbDir, inputVcf, outputHtml, scriptPath])

  return (
    <div className="qc-panel">
      <p className="qc-lead">
        Generate clinical HTML report from a VCF using your Python script:
        <code> vcf_report_generator.py &lt;input.vcf&gt; --output clinical_report.html</code>.
      </p>

      {error ? <div className="qc-error">{error}</div> : null}

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
            <p className="qc-hint">
              Selecting a patient creates an <code>ngs-report</code> folder inside it (if missing)
              and auto-fills the Input VCF below when{' '}
              <code>variant_annotation/annotated_variants.vcf</code> already exists. Otherwise,
              browse for a VCF manually.
            </p>
          </>
        )}
      </div>

      <div className="qc-field">
        <label htmlFor="civic-input-vcf">Input VCF path</label>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            id="civic-input-vcf"
            type="text"
            className="qc-input"
            placeholder="e.g. /home/ngs/ngs_data/Patient1/variant_annotation/annotated_variants.vcf"
            value={inputVcf}
            onChange={(e) => {
              const val = e.target.value
              setInputVcf(val)
              if (!userEditedOutput) {
                setOutputHtml(getOutputHtmlFor(val))
              }
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={loading || uploading}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="qc-browse"
            onClick={pickVcfFile}
            disabled={loading || browsing || uploading}
            title="Browse for VCF file"
          >
            Browse…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".vcf"
            style={{ display: 'none' }}
            onChange={handleVcfFileSelect}
          />
          <button
            type="button"
            className="qc-browse"
            style={{ fontSize: '0.8rem', padding: '0.35rem 0.6rem' }}
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || browsing || uploading}
            title="Upload VCF from your local computer"
          >
            {uploading ? 'Uploading…' : 'Upload…'}
          </button>
        </div>

        <FilePickerModal
          isOpen={showFileModal}
          initialPath={
            inputVcf.trim() ||
            (getPatientDir() ? `${getPatientDir()}/variant_annotation` : rootDir || '')
          }
          onSelect={(selected) => {
            setInputVcf(selected)
            if (!userEditedOutput) {
              setOutputHtml(getOutputHtmlFor(selected))
            }
          }}
          onClose={() => setShowFileModal(false)}
          title="Select Input VCF File"
          allowedExtensions={['.vcf', '.vcf.gz']}
          filterLabel="VCF files only (*.vcf, *.vcf.gz)"
        />
      </div>

      <div className="qc-field">
        <label htmlFor="civic-output-html">Output report HTML path</label>
        <input
          id="civic-output-html"
          type="text"
          className="qc-input"
          placeholder="e.g. /home/ngs/ngs_data/Patient1/ngs-report/annotated_variants_report.html"
          value={outputHtml}
          onChange={(e) => {
            setOutputHtml(e.target.value)
            setUserEditedOutput(Boolean(e.target.value.trim()))
          }}
          autoComplete="off"
          spellCheck={false}
          disabled={loading}
        />
        <p className="qc-hint">
          Auto-filled under <code>ngs-report</code> in the selected patient folder (created if
          missing). The parent folder must exist and be writable.
        </p>
      </div>


      <div className="qc-actions">
        <button
          type="button"
          className="qc-run"
          onClick={runReport}
          disabled={loading || uploading || !inputVcf.trim() || !outputHtml.trim()}
        >
          {loading ? 'Generating report…' : 'Generate clinical report'}
        </button>
        {reportPath && (
          <a
            className="qc-run"
            style={{ textDecoration: 'none', display: 'inline-block' }}
            href={`/api/downstream/download-report?path=${encodeURIComponent(reportPath)}`}
          >
            Download report
          </a>
        )}
      </div>

      <section className="qc-server-help">
        <h3 className="qc-help-title">Command preview</h3>
        <pre className="qc-cmd">{commandPreview}</pre>

      </section>

      {log && (
        <section className="qc-server-help">
          <h3 className="qc-help-title">Output</h3>
          <pre className="qc-cmd">{log}</pre>
        </section>
      )}

    </div>
  )
}

