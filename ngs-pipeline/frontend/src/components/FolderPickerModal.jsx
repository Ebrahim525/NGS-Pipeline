import { useCallback, useEffect, useState } from 'react'

export function FolderPickerModal({ isOpen, initialPath, onSelect, onClose }) {
  const [currentDir, setCurrentDir] = useState('')
  const [parentDir, setParentDir] = useState(null)
  const [folders, setFolders] = useState([])
  const [writable, setWritable] = useState(false)
  const [homeDir, setHomeDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [pathInput, setPathInput] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)

  const loadDirectory = useCallback(async (dirToLoad) => {
    setLoading(true)
    setError(null)
    try {
      const q = dirToLoad ? `?dir=${encodeURIComponent(dirToLoad)}` : ''
      const res = await fetch(`/api/setup/browse-folders${q}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setCurrentDir(data.current)
      setPathInput(data.current)
      setParentDir(data.parent)
      setFolders(data.folders || [])
      setWritable(Boolean(data.writable))
      if (data.homeDir) setHomeDir(data.homeDir)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      loadDirectory(initialPath || '')
      setShowNewFolder(false)
      setNewFolderName('')
    }
  }, [isOpen, initialPath, loadDirectory])

  if (!isOpen) return null

  const handleCreateFolder = async () => {
    const name = newFolderName.trim()
    if (!name || !currentDir) return
    setCreatingFolder(true)
    setError(null)
    try {
      const res = await fetch('/api/setup/subdirs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: currentDir, name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setNewFolderName('')
      setShowNewFolder(false)
      await loadDirectory(currentDir)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreatingFolder(false)
    }
  }

  return (
    <div className="folder-modal-backdrop" onClick={onClose}>
      <div className="folder-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="folder-modal-header">
          <h3 className="folder-modal-title">Select Location for ngs_data</h3>
          <button type="button" className="folder-modal-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="folder-modal-toolbar">
          <div className="folder-modal-nav-row">
            <button
              type="button"
              className="qc-browse"
              onClick={() => parentDir && loadDirectory(parentDir)}
              disabled={!parentDir || loading}
              title="Go up to parent directory"
            >
              ↑ Parent
            </button>
            {homeDir && (
              <button
                type="button"
                className="qc-browse"
                onClick={() => loadDirectory(homeDir)}
                disabled={loading}
                title="Go to home folder"
              >
                🏠 Home
              </button>
            )}
            <button
              type="button"
              className="qc-browse"
              onClick={() => loadDirectory('/')}
              disabled={loading}
              title="Go to filesystem root"
            >
              / Root
            </button>
            <button
              type="button"
              className="qc-browse"
              onClick={() => setShowNewFolder((v) => !v)}
              disabled={loading || !writable}
              title="Create new folder here"
            >
              {showNewFolder ? 'Cancel' : '+ New folder'}
            </button>
          </div>

          <form
            className="folder-modal-path-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (pathInput.trim()) loadDirectory(pathInput.trim())
            }}
          >
            <input
              type="text"
              className="qc-input folder-modal-path-input"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="/path/to/folder"
              autoComplete="off"
              spellCheck={false}
              disabled={loading}
            />
            <button type="submit" className="qc-browse" disabled={loading || !pathInput.trim()}>
              Go
            </button>
          </form>

          {showNewFolder && (
            <div className="qc-path-row" style={{ marginTop: '0.5rem' }}>
              <input
                type="text"
                className="qc-input"
                placeholder="Folder name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={creatingFolder}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleCreateFolder()
                  }
                }}
              />
              <button
                type="button"
                className="qc-browse"
                onClick={handleCreateFolder}
                disabled={creatingFolder || !newFolderName.trim()}
              >
                {creatingFolder ? 'Creating…' : 'Create'}
              </button>
            </div>
          )}
        </div>

        {error && <div className="qc-error" style={{ margin: '0.5rem 0' }}>{error}</div>}

        <div className="folder-modal-list-header">
          <span>Subfolders in: <code>{currentDir}</code></span>
          {writable ? (
            <span className="folder-writable-badge" style={{ color: '#22c55e', fontSize: '0.8rem' }}>
              ✓ Writable
            </span>
          ) : (
            <span className="folder-writable-badge" style={{ color: '#eab308', fontSize: '0.8rem' }}>
              ⚠️ Read-only
            </span>
          )}
        </div>

        <div className="folder-modal-list">
          {loading ? (
            <div className="folder-modal-empty">Loading folders…</div>
          ) : folders.length === 0 ? (
            <div className="folder-modal-empty">No subdirectories found in this location.</div>
          ) : (
            folders.map((f) => (
              <button
                key={f}
                type="button"
                className="folder-modal-item"
                onClick={() => loadDirectory(`${currentDir.replace(/[\\/]+$/, '')}/${f}`)}
              >
                <span className="folder-modal-icon">📁</span>
                <span className="folder-modal-name">{f}</span>
              </button>
            ))
          )}
        </div>

        <div className="folder-modal-footer">
          <div className="folder-modal-selection">
            Selected: <code>{currentDir}</code>
          </div>
          <div className="folder-modal-actions">
            <button type="button" className="qc-browse" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="qc-run"
              onClick={() => {
                onSelect(currentDir)
                onClose()
              }}
              disabled={!currentDir || loading}
            >
              Select this location
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
