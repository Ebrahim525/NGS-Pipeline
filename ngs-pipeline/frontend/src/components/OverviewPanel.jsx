import { useCallback, useEffect, useState } from 'react'
import { useRootDir } from '../RootDirContext.jsx'
import { FolderPickerModal } from './FolderPickerModal.jsx'

export function OverviewPanel() {
  const { rootDir, setRootDir } = useRootDir()
  const [basePath, setBasePath] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [showFolderModal, setShowFolderModal] = useState(false)

  useEffect(() => {
    if (rootDir) return
    let cancelled = false
    fetch('/api/setup/root-dir-info')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.defaultBase) setBasePath(data.defaultBase)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [rootDir])

  const pickFolder = async () => {
    setBrowsing(true)
    setError(null)
    try {
      const res = await fetch('/api/folder-picker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialDir: basePath || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.folderPath) {
        setBasePath(data.folderPath)
        return
      }
      if (data?.cancelled) {
        return
      }
      // If native desktop dialog is not available / needs browser picker
      setShowFolderModal(true)
    } catch {
      setShowFolderModal(true)
    } finally {
      setBrowsing(false)
    }
  }

  const createRootDir = useCallback(async () => {
    setError(null)
    setResult(null)
    setCreating(true)
    try {
      const res = await fetch('/api/setup/root-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basePath: basePath.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setResult(data)
      setRootDir(data.rootDir)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }, [basePath, setRootDir])

  return (
    <div className="qc-panel overview-panel">
      <div className="collab-banner">
        <div className="collab-partner">
          <img src="/image.png" alt="Institution A logo" className="collab-logo" />
        </div>
        <div className="collab-partner">
          <img src="/office2405202514_32_33.jpg" alt="Institution B logo" className="collab-logo" />
        </div>
      </div>
      <p className="qc-lead">
        <strong>NGS pipeline</strong> is a step-by-step UI for running common next-generation
        sequencing processing tasks on your local machine. Most steps execute tools locally via the
        API (and for alignment/GATK/VEP, via <strong>WSL</strong>), so you provide file paths instead
        of uploading large FASTQ/BAM/VCF files.
      </p>

      <section className="align-section">
        <h3 className="qc-help-title">Data root directory setup</h3>
        <p className="qc-hint">
          Choose the location where the <code>ngs_data</code> root directory should live, then
          create it if it does not already exist. This folder can be used to store pipeline
          inputs/outputs across steps.
        </p>
        <div className="qc-field">
          <label>Location for &quot;ngs_data&quot;</label>
          <div className="qc-path-row">
            <input
              type="text"
              className="qc-input"
              placeholder="e.g. /home/user or C:\Users\you\Documents"
              value={basePath}
              onChange={(e) => setBasePath(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={creating || browsing}
            />
            <button
              type="button"
              className="qc-browse"
              onClick={pickFolder}
              disabled={creating || browsing}
              title="Browse for folder"
            >
              Browse…
            </button>
          </div>
        </div>

        <FolderPickerModal
          isOpen={showFolderModal}
          initialPath={basePath}
          onSelect={(selected) => setBasePath(selected)}
          onClose={() => setShowFolderModal(false)}
        />

        <div className="qc-actions">
          <button
            type="button"
            className="qc-run"
            onClick={createRootDir}
            disabled={creating || browsing || !basePath.trim()}
          >
            {creating ? 'Setting up…' : 'Create ngs_data directory'}
          </button>
        </div>

        {result && (
          <div className="qc-success">
            {result.alreadyExisted ? (
              <>
                <strong>Already exists:</strong> <code>{result.rootDir}</code>
              </>
            ) : (
              <>
                <strong>Created:</strong> <code>{result.rootDir}</code>
              </>
            )}
          </div>
        )}

        {error && <div className="qc-error">{error}</div>}

        {rootDir && !result && (
          <p className="qc-hint">
            Currently configured root directory: <code>{rootDir}</code>
          </p>
        )}
      </section>

      <section className="align-section">
        <h3 className="qc-help-title">What this website does</h3>
        <ul className="qc-help-list">
          <li>
            Guides you through key pipeline steps (QC → trimming → alignment → post-alignment → variant
            calling → annotation).
          </li>
          <li>
            Runs commands on your computer (no cloud upload) and shows logs/output in the browser.
          </li>
          <li>
            Uses <strong>WSL paths</strong> (like <code>~/hg38.fa</code>) for the steps that run in WSL.
          </li>
        </ul>
      </section>

      <section className="align-section">
        <h3 className="qc-help-title">First-time setup (one time)</h3>
        <ol className="qc-help-list">
          <li>
            Install dependencies: in folder <code>backend</code>, run <code>npm install</code>.
          </li>
          <li>
            Copy <code>backend/.env.example</code> to <code>backend/.env</code> and fill required
            variables (at minimum, <code>FASTQC_DIR</code>).
          </li>
          <li>
            Start the API (port 8787): run <code>npm run dev</code> in <code>backend</code>, or run{' '}
            <code>npm run dev</code> in <code>frontend</code> to start Vite and proxy to the API.
          </li>
          <li>
            Java must be on <code>PATH</code> (or set <code>JAVA_HOME</code>) for tools that use it
            (FastQC / Picard / GATK). The FastQC API runs:
            <code className="qc-cmd">
              java -Xmx250m -classpath &quot;bin;…jars…&quot; uk.ac.babraham.FastQC.FastQCApplication -o
              &lt;temp&gt; &lt;your file&gt;
            </code>
          </li>
          <li>
            For WSL-only steps (alignment, Picard jar, GATK jar, VEP), keep your reference/FASTQ/BAM/VCF
            files in the WSL filesystem (e.g. <code>/home/you</code>) and use WSL-style paths.
          </li>
        </ol>
      </section>
    </div>
  )
}

