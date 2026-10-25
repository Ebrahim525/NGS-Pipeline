import { useCallback, useEffect, useState } from 'react'
import { useRootDir } from '../RootDirContext.jsx'
import { FilePickerModal } from './FilePickerModal.jsx'

export function QualityControlPanel() {
  const { rootDir, selectedPatient: selectedFolder, setSelectedPatient: setSelectedFolder } = useRootDir()
  const [inputPaths, setInputPaths] = useState([''])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [showFileModal, setShowFileModal] = useState(false)
  const [activePickerIndex, setActivePickerIndex] = useState(0)

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

  const updatePath = (index, value) => {
    setInputPaths((prev) => prev.map((p, i) => (i === index ? value : p)))
  }

  const [browsing, setBrowsing] = useState(false)

  const addPath = () => setInputPaths((prev) => [...prev, ''])

  const removePath = (index) => setInputPaths((prev) => prev.filter((_, i) => i !== index))

  const getPatientDir = useCallback(() => {
    if (!rootDir || !selectedFolder) return ''
    return `${rootDir.replace(/[\\/]+$/, '')}/${selectedFolder}`
  }, [rootDir, selectedFolder])

  const pickFile = async (index) => {
    setActivePickerIndex(index)
    setError(null)
    setBrowsing(true)
    try {
      const existing = inputPaths[index]?.trim()
      const baseDir = existing || getPatientDir() || rootDir
      const res = await fetch('/api/file-picker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: baseDir }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.filePath) {
        updatePath(index, data.filePath)
        return
      }
      if (data?.cancelled) {
        return
      }
      // If native dialog is not available / needs browser picker
      setShowFileModal(true)
    } catch {
      setShowFileModal(true)
    } finally {
      setBrowsing(false)
    }
  }

  const runQc = useCallback(async () => {
    setError(null)
    setResult(null)
    const patientDir = getPatientDir()
    if (!patientDir) {
      setError('Select a patient folder before running FastQC.')
      return
    }
    setLoading(true)
    try {
      const paths = inputPaths.map((p) => p.trim()).filter(Boolean)
      const res = await fetch('/api/qc/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputPaths: paths, patientDir }),
      })

      const text = await res.text()
      let data
      try { data = text ? JSON.parse(text) : {} } catch { throw new Error(text || res.statusText) }
      if (!res.ok) {
        throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error || res.statusText)
      }
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [inputPaths, getPatientDir])

  return (
    <div className="qc-panel">
      <p className="qc-lead">
        Run FastQC on a file that already exists on this system. Select or create a patient folder,
        then choose your input file(s). The file(s) are copied into the patient folder and results
        are saved to a <strong>quality_control</strong> folder created inside it.
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
        <label>Path(s) to input files</label>
        {inputPaths.map((p, index) => (
          <div key={index} className="qc-path-row">
            <input
              type="text"
              className="qc-input"
              placeholder={`e.g. /path/to/sample_R${index + 1}.fastq.gz or C:\\data\\sample_R${index + 1}.fastq.gz`}
              value={p}
              onChange={(e) => updatePath(index, e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={loading || browsing}
            />
            <button
              type="button"
              className="qc-browse"
              onClick={() => pickFile(index)}
              disabled={loading || browsing}
              title="Browse for file"
            >
              Browse…
            </button>
            {inputPaths.length > 1 && (
              <button
                type="button"
                className="qc-remove"
                onClick={() => removePath(index)}
                disabled={loading || browsing}
                aria-label="Remove file"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button type="button" className="qc-add" onClick={addPath} disabled={loading || browsing}>
          + Add file
        </button>
        <p className="qc-hint">
          Use full paths to your <code>.fastq</code>, <code>.fq.gz</code>, or other
          FastQC-supported files.
        </p>

        <FilePickerModal
          isOpen={showFileModal}
          initialPath={inputPaths[activePickerIndex]?.trim() || getPatientDir() || rootDir}
          onSelect={(selected) => updatePath(activePickerIndex, selected)}
          onClose={() => setShowFileModal(false)}
          title="Select FastQC Input File"
        />
      </div>

      <div className="qc-actions">
        <button
          type="button"
          className="qc-run"
          onClick={runQc}
          disabled={loading || browsing || !selectedFolder || !inputPaths.some((p) => p.trim())}
        >
          {loading ? 'Running FastQC…' : 'Run FastQC'}
        </button>
        {!selectedFolder && (
          <p className="qc-hint">Select or create a patient folder above to enable this.</p>
        )}
      </div>

      {result && (
        <div className="qc-success">
          <strong>FastQC complete.</strong>
          <p>
            Input file(s) copied to: <code>{selectedFolder ? getPatientDir() : ''}</code>
          </p>
          <p>
            Report saved to: <code>{result.outDir}</code>
          </p>
          <ul className="qc-file-list">
            {result.files.map((f) => (
              <li key={f}>
                {f}
                {f.endsWith('.html') && (
                  <a
                    className="qc-download-btn"
                    href={`/api/qc/download-html?outDir=${encodeURIComponent(result.outDir)}&file=${encodeURIComponent(f)}`}
                    download={f}
                  >
                    Download HTML
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="qc-error">{error}</div>}

      <section className="qc-server-help">
        <h3 className="qc-help-title">FastQC setup (one time)</h3>
        <ol className="qc-help-list">

          <li>
            Set <code>FASTQC_DIR</code> to your cloned FastQC project root (the folder that contains{' '}
            <code>bin</code>, <code>sam-1.103.jar</code>, <code>jbzip2-0.9.jar</code>).
          </li>

          <li>
            Java must be on <code>PATH</code> (or set <code>JAVA_HOME</code>). The API runs:{' '}
            <code className="qc-cmd">
              java -Xmx250m -classpath &quot;bin;…jars…&quot; uk.ac.babraham.FastQC.FastQCApplication -o
              &lt;temp&gt; &lt;your file&gt;
            </code>
          </li>
        </ol>
      </section>
    </div>
  )
}
