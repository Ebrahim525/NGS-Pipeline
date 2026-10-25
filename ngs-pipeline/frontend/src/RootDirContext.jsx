import { createContext, useContext, useEffect, useState } from 'react'

const RootDirContext = createContext({
  rootDir: '',
  setRootDir: () => {},
  selectedPatient: '',
  setSelectedPatient: () => {},
})

/** Loads the persisted ngs_data root dir once and shares it with all pipeline step panels. */
export function RootDirProvider({ children }) {
  const [rootDir, setRootDir] = useState('')
  // Shared across all pipeline panels so the same patient stays selected as the user moves
  // between Quality Control, Alignment, Post-alignment, Variant Calling, etc.
  const [selectedPatient, setSelectedPatient] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/setup/root-dir')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.rootDir) setRootDir(data.rootDir)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <RootDirContext.Provider value={{ rootDir, setRootDir, selectedPatient, setSelectedPatient }}>
      {children}
    </RootDirContext.Provider>
  )
}

export function useRootDir() {
  return useContext(RootDirContext)
}

