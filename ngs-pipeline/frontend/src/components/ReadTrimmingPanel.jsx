import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRootDir } from '../RootDirContext.jsx'
import { FilePickerModal } from './FilePickerModal.jsx'

export function ReadTrimmingPanel() {
  const { rootDir, selectedPatient: selectedFolder, setSelectedPatient: setSelectedFolder } = useRootDir()
  const [inputPath, setInputPath] = useState('')
  const [ref, setRef] = useState('adapters')
  const [customCommand, setCustomCommand] = useState('')
  const [commandEdited, setCommandEdited] = useState(false)
  const [loading, setLoading] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [showFileModal, setShowFileModal] = useState(false)
  const [error, setError] = useState(null)
  const [log, setLog] = useState('')
  const [result, setResult] = useState(null)

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

  const getOutputPreviewPath = useCallback(() => {
    const patientDir = getPatientDir()
    const inn = inputPath.trim()
    if (!patientDir || !inn) return ''
    const base = inn.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
    return `${patientDir}\\trimming\\cleaned_${base}`
  }, [getPatientDir, inputPath])

  const pickInputFile = async () => {
    setError(null)
    setBrowsing(true)
    try {
      const baseDir = inputPath.trim() || getPatientDir() || rootDir
      const res = await fetch('/api/file-picker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: baseDir }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.filePath) {
        setInputPath(data.filePath)
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

  const previewCmd = useMemo(() => {
    const toFwd = (p) => p.replace(/\\/g, '/')
    const inn = toFwd(inputPath.trim()) || '/path/to/sample.fastq'
    const out = toFwd(getOutputPreviewPath()) || '/path/to/patient/trimming/cleaned_sample.fastq'
    const r = ref.trim() || 'adapters'
    return [
      './bbduk.sh \\',
      `  in="${inn}" \\`,
      `  out="${out}" \\`,
      `  ref=${r} \\`,
      '  ktrim=r \\',
      '  k=23 \\',
      '  mink=11 \\',
      '  hdist=1 \\',
      '  qtrim=r \\',
      '  trimq=20 \\',
      '  minlen=30',
    ].join('\n')
  }, [inputPath, getOutputPreviewPath, ref])

  const runTrim = useCallback(async () => {
    setError(null)
    setLog('')
    setResult(null)
    const inn = inputPath.trim()
    const patientDir = getPatientDir()
    if (!inn) {
      setError('Select the input FASTQ file.')
      return
    }
    if (!patientDir) {
      setError('Select or create a patient folder before running BBDuk.')
      return
    }
    setLoading(true)
    try {
      // previewCmd is illustrative only; only override the API's own auto-built command
      // when the user has actually edited it.
      const body = { inputPath: inn, patientDir, ref: ref.trim() || 'adapters' }
      if (commandEdited) {
        const finalCommand = customCommand.trim()
        if (!finalCommand) {
          setError('Enter a BBDuk shell command to run.')
          setLoading(false)
          return
        }
        body.command = finalCommand
      }
      const res = await fetch('/api/trimming/bbduk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          data.detail ? `${data.error || 'Error'}: ${data.detail}` : data.error || res.statusText,
        )
      }
      const parts = [data.stdout, data.stderr].filter(Boolean)
      setLog(parts.join('\n') || 'Finished (no output on stdout/stderr).')
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [commandEdited, customCommand, inputPath, ref, getPatientDir])

  return (
    <div className="qc-panel">
      <p className="qc-lead">
        Trim adapters and low-quality bases with BBMap <code>bbduk.sh</code>. Select or create a
        patient folder, then browse for the input FASTQ. The cleaned output is written to a{' '}
        <strong>trimming</strong> folder under the patient folder, named <code>cleaned_&lt;input file name&gt;</code>.
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
        <label htmlFor="trim-input-path">Input FASTQ path</label>
        <div className="qc-path-row">
          <input
            id="trim-input-path"
            type="text"
            className="qc-input"
            placeholder="e.g. /home/user/sample.fastq or C:\data\sample.fastq"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={loading || browsing}
          />
          <button
            type="button"
            className="qc-browse"
            onClick={pickInputFile}
            disabled={loading || browsing}
            title="Browse for file"
          >
            Browse…
          </button>
        </div>

        <FilePickerModal
          isOpen={showFileModal}
          initialPath={inputPath.trim() || getPatientDir() || rootDir}
          onSelect={(selected) => setInputPath(selected)}
          onClose={() => setShowFileModal(false)}
          title="Select Input FASTQ File"
        />
      </div>

      <div className="qc-field">
        <label>Output cleaned FASTQ path</label>
        <input
          type="text"
          className="qc-input"
          value={getOutputPreviewPath()}
          placeholder="Select a patient folder and input file to see the output path"
          disabled
          readOnly
        />
        <p className="qc-hint">
          Auto-filled as <code>&lt;patient folder&gt;\trimming\cleaned_&lt;input file name&gt;</code>.
        </p>
      </div>

      <div className="qc-field">
        <label htmlFor="trim-ref">Adapter reference (BBDuk ref=)</label>
        <input
          id="trim-ref"
          type="text"
          className="qc-input"
          placeholder="adapters"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={loading}
        />
        <p className="qc-hint">
          Use built-in <code>adapters</code> or a full path to a FASTA of sequences.
        </p>
      </div>

      <div className="qc-actions">
        <button
          type="button"
          className="qc-run"
          onClick={runTrim}
          disabled={loading || browsing || !selectedFolder || !inputPath.trim()}
        >
          {loading ? 'Running BBDuk…' : 'Run BBDuk'}
        </button>
        {!selectedFolder && (
          <p className="qc-hint">Select or create a patient folder above to enable this.</p>
        )}
      </div>

      {result && (
        <div className="qc-success">
          <strong>BBDuk complete.</strong>
          <p>
            Output written to: <code>{result.outputPath}</code>
          </p>
        </div>
      )}

      {log ? (
        <pre className="qc-cmd" style={{ whiteSpace: 'pre-wrap', marginTop: '1rem' }}>
          {log}
        </pre>
      ) : null}

      {error && <div className="qc-error">{error}</div>}

      <section className="qc-server-help">
        <h3 className="qc-help-title">shell command</h3>
        <p className="qc-hint">
          Illustrative only. Leave this untouched and <strong>Run BBDuk</strong> uses the API&apos;s own
          auto-built command instead.
        </p>
        <textarea
          className="qc-input align-textarea"
          value={commandEdited ? customCommand : previewCmd}
          onChange={(e) => {
            setCommandEdited(true)
            setCustomCommand(e.target.value)
          }}
          disabled={loading}
          spellCheck={false}
          rows={8}
        />
        <h3 className="qc-help-title">BBduk setup</h3>
        <ol className="qc-help-list">
          <li>
            Set <code>BBMAP_DIR</code> in <code>backend/.env</code> to the folder that contains{' '}
            <code>bbduk.sh</code> (for example <code>C:\Users\DELL\Downloads\BBMap_39.01\bbmap</code>).
          </li>
          <li>
            Install <a href="https://git-scm.com/download/win">Git for Windows</a> so <code>bash.exe</code> exists,
            or set <code>GIT_BASH</code> to its full path.
          </li>
        </ol>
      </section>
    </div>
  )
}
