import { useCallback, useEffect, useMemo, useState } from 'react'

const COMMON_FASTQ_EXTENSIONS = ['.fastq', '.fq', '.fastq.gz', '.fq.gz', '.bam', '.sam', '.vcf', '.gz']

export function FilePickerModal({
  isOpen,
  initialPath,
  onSelect,
  onClose,
  title = 'Select Input File',
  filterExtensions = true,
  allowedExtensions,
  filterLabel,
}) {
  const [currentDir, setCurrentDir] = useState('')
  const [parentDir, setParentDir] = useState(null)
  const [folders, setFolders] = useState([])
  const [files, setFiles] = useState([])
  const [writable, setWritable] = useState(false)
  const [homeDir, setHomeDir] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [pathInput, setPathInput] = useState('')
  const [selectedFile, setSelectedFile] = useState('')
  const [filterQuery, setFilterQuery] = useState('')
  const [applyFilter, setApplyFilter] = useState(filterExtensions)
  const [newFolderName, setNewFolderName] = useState('')
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)

  const loadDirectory = useCallback(async (dirToLoad) => {
    setLoading(true)
    setError(null)
    setSelectedFile('')
    try {
      const q = dirToLoad ? `?dir=${encodeURIComponent(dirToLoad)}` : ''
      const res = await fetch(`/api/setup/browse-files${q}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || res.statusText)
      setCurrentDir(data.current)
      setPathInput(data.current)
      setParentDir(data.parent)
      setFolders(data.folders || [])
      setFiles(data.files || [])
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
      setSelectedFile('')
      setFilterQuery('')
      setShowNewFolder(false)
      setNewFolderName('')
      loadDirectory(initialPath || '')
    }
  }, [isOpen, initialPath, loadDirectory])

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

  const filteredFolders = useMemo(() => {
    const q = filterQuery.trim().toLowerCase()
    if (!q) return folders
    return folders.filter((f) => f.toLowerCase().includes(q))
  }, [folders, filterQuery])

  const filteredFiles = useMemo(() => {
    let list = files
    if (applyFilter) {
      const allowed = allowedExtensions && allowedExtensions.length > 0 ? allowedExtensions : COMMON_FASTQ_EXTENSIONS
      list = list.filter((f) => {
        const lower = f.toLowerCase()
        return allowed.some((ext) => lower.endsWith(ext))
      })
    }
    const q = filterQuery.trim().toLowerCase()
    if (q) {
      list = list.filter((f) => f.toLowerCase().includes(q))
    }
    return list
  }, [files, applyFilter, filterQuery, allowedExtensions])

  if (!isOpen) return null

  const selectedFullPath = selectedFile
    ? `${currentDir.replace(/[\\/]+$/, '')}/${selectedFile}`
    : ''

  const handleConfirm = (filePathToConfirm) => {
    const target = filePathToConfirm || selectedFullPath
    if (target) {
      onSelect(target)
      onClose()
    }
  }

  return (
    <div className="folder-modal-backdrop" onClick={onClose}>
      <div className="folder-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="folder-modal-header">
          <h3 className="folder-modal-title">{title}</h3>
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
            <div className="qc-path-row" style={{ marginTop: '0.25rem' }}>
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

          <div className="folder-modal-filter-row">
            <input
              type="text"
              className="qc-input"
              placeholder="Search / filter files..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              style={{ flex: 1, padding: '0.35rem 0.6rem', fontSize: '0.85rem' }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={applyFilter}
                onChange={(e) => setApplyFilter(e.target.checked)}
              />
              {filterLabel || 'Supported only (*.fastq, *.fq, *.gz, *.bam, *.sam, *.vcf)'}
            </label>
          </div>
        </div>

        {error && <div className="qc-error" style={{ margin: '0.5rem 0' }}>{error}</div>}

        <div className="folder-modal-list-header">
          <span>Folder: <code>{currentDir}</code></span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text)' }}>
            {filteredFolders.length} folder{filteredFolders.length === 1 ? '' : 's'}, {filteredFiles.length} file{filteredFiles.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="folder-modal-list">
          {loading ? (
            <div className="folder-modal-empty">Loading contents…</div>
          ) : filteredFolders.length === 0 && filteredFiles.length === 0 ? (
            <div className="folder-modal-empty">
              {filterQuery || applyFilter
                ? 'No matching files or folders found.'
                : 'This directory is empty.'}
            </div>
          ) : (
            <>
              {filteredFolders.map((f) => (
                <button
                  key={`folder-${f}`}
                  type="button"
                  className="folder-modal-item"
                  onClick={() => loadDirectory(`${currentDir.replace(/[\\/]+$/, '')}/${f}`)}
                  title={`Open folder ${f}`}
                >
                  <span className="folder-modal-icon">📁</span>
                  <span className="folder-modal-name" style={{ fontWeight: 600 }}>{f}/</span>
                </button>
              ))}
              {filteredFiles.map((f) => {
                const isSelected = selectedFile === f
                const full = `${currentDir.replace(/[\\/]+$/, '')}/${f}`
                return (
                  <button
                    key={`file-${f}`}
                    type="button"
                    className={`folder-modal-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedFile(f)}
                    onDoubleClick={() => handleConfirm(full)}
                    title={`Click to select, double-click to confirm: ${f}`}
                  >
                    <span className="folder-modal-icon">📄</span>
                    <span className="folder-modal-name">{f}</span>
                  </button>
                )
              })}
            </>
          )}
        </div>

        <div className="folder-modal-footer">
          <div className="folder-modal-selection">
            {selectedFullPath ? (
              <>Selected: <code>{selectedFullPath}</code></>
            ) : (
              <span style={{ color: 'var(--text)' }}>No file selected. Click a file above to select it.</span>
            )}
          </div>
          <div className="folder-modal-actions">
            <button type="button" className="qc-browse" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="qc-run"
              onClick={() => handleConfirm()}
              disabled={!selectedFullPath || loading}
            >
              Select this file
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
