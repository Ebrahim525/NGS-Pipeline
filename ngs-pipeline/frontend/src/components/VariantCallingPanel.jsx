import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRootDir } from '../RootDirContext.jsx'

/** Shown in prerequisite copy blocks; server uses PICARD_JAVA from backend/.env */
const JAVA_PREVIEW = '/usr/lib/jvm/java-17-openjdk-amd64/bin/java'
const defaultGatkJar = '~/ngs-pipeline/gatk-4.5.0.0/gatk-package-4.5.0.0-local.jar'

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

const PREREQ_FAIDX = 'samtools faidx ~/hg38.fa'

const PREREQ_DICT = `${JAVA_PREVIEW} -jar ${defaultGatkJar} CreateSequenceDictionary \\
  -R ~/hg38.fa \\
  -O ~/hg38.dict`

const RG_DEFAULTS = { rgid: '1', rglb: 'lib1', rgpl: 'ILLUMINA', rgpu: 'unit1', rgsm: 'sample1' }

export function VariantCallingPanel() {
  const { rootDir, selectedPatient: selectedFolder, setSelectedPatient: setSelectedFolder } = useRootDir()
  const [gatkJar, setGatkJar] = useState(defaultGatkJar)
  const [refPath, setRefPath] = useState('')
  const [inputBam, setInputBam] = useState('')
  const [outputVcf, setOutputVcf] = useState('')

  const [runLoading, setRunLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [prepareRefLoading, setPrepareRefLoading] = useState(false);
  const [prepareRefError, setPrepareRefError] = useState(null);

  const [folders, setFolders] = useState([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderError, setFolderError] = useState(null)

  const [rgBam, setRgBam] = useState('')
  const [rgLoading, setRgLoading] = useState(false)
  const [rgError, setRgError] = useState(null)
  const [rgResult, setRgResult] = useState(null)
  const [rgIndexLoading, setRgIndexLoading] = useState(false)

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
    // Use forward slash for POSIX style paths expected by backend APIs
    return `${rootDir.replace(/[\\/]+$/, '')}/${selectedFolder}`
  }, [rootDir, selectedFolder])

  // Section B: input is the deduplicated BAM from post_alignment; output goes to variant_calling.
  const getDedupBamPreview = useCallback(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return ''
    return `${toWslPath(patientDir)}/post_alignment/dedup.bam`
  }, [getPatientDir])

  const getRgBamPreview = useCallback(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return ''
    return `${toWslPath(patientDir)}/variant_calling/dedup_rg.bam`
  }, [getPatientDir])

  // Keep the read-group output BAM in sync with the selected patient.
  useEffect(() => {
    const preview = getRgBamPreview()
    if (preview) setRgBam(preview)
  }, [getRgBamPreview])

  // Section C output: the final compressed VCF, also written under variant_calling.
  const getVcfOutputPreview = useCallback(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return ''
    return `${toWslPath(patientDir)}/variant_calling/variants.vcf.gz`
  }, [getPatientDir])

  // Auto-fill section C (HaplotypeCaller) once a patient is selected: reference defaults to
  // ~/hg38.fa, input is the read-group BAM from section B, output goes to variant_calling.
  useEffect(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return
    setRefPath('~/hg38.fa')
    setInputBam(getRgBamPreview())
    setOutputVcf(getVcfOutputPreview())
  }, [getPatientDir, getRgBamPreview, getVcfOutputPreview])

  // Create the variant_calling folder under the patient folder as soon as it's selected, so it's
  // ready before the user runs AddOrReplaceReadGroups (which would create it anyway).
  useEffect(() => {
    const patientDir = getPatientDir()
    if (!patientDir) return
    let cancelled = false
    fetch('/api/setup/subdirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: patientDir, name: 'variant_calling' }),
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

  const rgCmdPreview = useMemo(() => {
    const i = getDedupBamPreview() || '~/dedup.bam'
    const o = rgBam.trim() || getRgBamPreview() || '~/dedup_rg.bam'
    return [
      'java -jar ~/ngs-pipeline/picard.jar AddOrReplaceReadGroups \\',
      `  I=${i} \\`,
      `  O=${o} \\`,
      `  RGID=${RG_DEFAULTS.rgid} RGLB=${RG_DEFAULTS.rglb} RGPL=${RG_DEFAULTS.rgpl} RGPU=${RG_DEFAULTS.rgpu} RGSM=${RG_DEFAULTS.rgsm}`,
    ].join('\n')
  }, [getDedupBamPreview, rgBam, getRgBamPreview])

  const indexRgCmdPreview = useMemo(() => {
    const b = rgBam.trim() || getRgBamPreview() || '~/dedup_rg.bam'
    return `samtools index ${b}`
  }, [rgBam, getRgBamPreview])

  const runAddReadGroups = useCallback(async () => {
    setRgError(null)
    setRgResult(null)
    const i = getDedupBamPreview()
    const patientDir = getPatientDir()
    if (!i || !patientDir) {
      setRgError('Select or create a patient folder before running AddOrReplaceReadGroups.')
      return
    }
    setRgLoading(true)
    try {
      const res = await fetch('/api/variant-calling/add-read-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputBam: i, patientDir, ...RG_DEFAULTS }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          data.detail ? `${data.error || 'Error'}: ${data.detail}` : data.error || res.statusText,
        )
      }
      setRgResult(data)
      if (data.outputBam) {
        setRgBam(data.outputBam)
        setInputBam(data.outputBam)
      }
    } catch (e) {
      setRgError(e instanceof Error ? e.message : String(e))
    } finally {
      setRgLoading(false)
    }
  }, [getDedupBamPreview, getPatientDir])

  const runIndexRgBam = useCallback(async () => {
    const bam = rgBam.trim() || getRgBamPreview()
    if (!bam) return
    setRgIndexLoading(true)
    setRgError(null)
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
      setInputBam(bam)
    } catch (e) {
      setRgError(e instanceof Error ? e.message : String(e))
    } finally {
      setRgIndexLoading(false)
    }
  }, [rgBam, getRgBamPreview])

  const canRunAddReadGroups = Boolean(selectedFolder && getDedupBamPreview()) && !rgLoading
  const canRunIndexRg = Boolean((rgBam.trim() || getRgBamPreview()) && !rgIndexLoading)

  const hcPreview = useMemo(() => {
    const jar = gatkJar.trim() || defaultGatkJar
    const r = refPath.trim()
    const i = inputBam.trim()
    const o = outputVcf.trim()
    if (!r || !i || !o) {
      return [
        `${JAVA_PREVIEW} -jar ${jar} HaplotypeCaller \\`,
        '  -R ~/hg38.fa \\',
        '  -I ~/dedup_rg.bam \\',
        '  -O ~/variants1.vcf.gz',
      ].join('\n')
    }
    return [
      `${JAVA_PREVIEW} -jar ${jar} HaplotypeCaller \\`,
      `  -R ${r} \\`,
      `  -I ${i} \\`,
      `  -O ${o}`,
    ].join('\n')
  }, [gatkJar, refPath, inputBam, outputVcf])

  const runHaplotypeCaller = useCallback(async () => {
    const r = refPath.trim()
    const i = inputBam.trim()
    const o = outputVcf.trim()
    const jar = gatkJar.trim() || defaultGatkJar
    if (!r || !i || !o) {
      return
    }
    setRunLoading(true)
    try {
      const res = await fetch('/api/variant-calling/haplotype-caller', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gatkJar: jar,
          refPath: r,
          inputBam: i,
          outputVcf: o,
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
  }, [gatkJar, refPath, inputBam, outputVcf])

  const runPrepareReference = useCallback(async () => {
    setPrepareRefLoading(true);
    setPrepareRefError(null);
    try {
      const res = await fetch('/api/variant-calling/prepare-reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refPath: refPath.trim() || '~/hg38.fa',
          gatkJar: gatkJar.trim() || defaultGatkJar,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || res.statusText);
      }
    } catch (e) {
      setPrepareRefError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrepareRefLoading(false);
    }
  }, [gatkJar, refPath]);

  const canRun =
    Boolean(refPath.trim() && inputBam.trim() && outputVcf.trim()) && !runLoading

  return (
    <div className="qc-panel align-panel">
      <p className="qc-lead">
        <strong>Variant calling (GATK HaplotypeCaller)</strong> needs a prepared reference, an indexed
        BAM with read groups, and then produces a compressed VCF. Complete sections A and B in WSL{' '}
        <strong>before</strong> running HaplotypeCaller in section C.
      </p>

      <section className="align-section">
        <h3 className="qc-help-title">A. Prepare the reference (required for GATK)</h3>
        <p className="qc-hint">
          Run from the folder that contains <code>hg38.fa</code> or use full <code>~/…</code> paths.
          GATK needs the FASTA index and sequence dictionary.
        </p>
        <p className="qc-hint">
          <strong>1.</strong> Create the FASTA index (<code>hg38.fa.fai</code>):
        </p>
        <pre className="qc-cmd align-pre">{PREREQ_FAIDX}</pre>
        <button
          type="button"
          className="qc-run align-copy"
          onClick={() => copyToClipboard(PREREQ_FAIDX, setCopied)}
        >
          Copy
        </button>
        <p className="qc-hint">
          <strong>2.</strong> Create the sequence dictionary (<code>hg38.dict</code>):
        </p>
        <pre className="qc-cmd align-pre">{PREREQ_DICT}</pre>
        <button
          type="button"
          className="qc-run align-copy"
          onClick={() => copyToClipboard(PREREQ_DICT, setCopied)}
        >
          Copy
        </button>
        <button
          type="button"
          className="qc-run"
          onClick={runPrepareReference}
          disabled={prepareRefLoading}
        >
          {prepareRefLoading ? 'Running...' : 'Run reference prep'}
        </button>
        {prepareRefError && <div className="qc-error">{prepareRefError}</div>}
      </section>

      <section className="align-section">
        <h3 className="qc-help-title">B. Prepare the BAM (read groups + index)</h3>
        <p className="qc-hint">
          HaplotypeCaller requires <strong>read groups</strong> on the BAM and a <strong>.bai</strong>{' '}
          index. Select the patient folder used for quality control below — the input BAM
          (<code>post_alignment/dedup.bam</code>) and output path
          (<code>variant_calling/dedup_rg.bam</code>) are filled in automatically, and the{' '}
          <code>variant_calling</code> folder is created if it doesn't exist yet.
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
          <label>Input deduplicated BAM (I=)</label>
          <input
            type="text"
            className="qc-input"
            value={getDedupBamPreview()}
            placeholder="Select a patient folder to see the input path"
            disabled
            readOnly
          />
        </div>

        <div className="qc-field">
          <label>Output read-group BAM (O=)</label>
          <input
            type="text"
            className="qc-input"
            value={rgBam}
            placeholder="Select a patient folder to see the output path"
            disabled
            readOnly
          />
        </div>

        <pre className="qc-cmd align-pre">{rgCmdPreview}</pre>
        <div className="qc-actions align-actions-row">
          <button
            type="button"
            className="qc-run"
            onClick={runAddReadGroups}
            disabled={!canRunAddReadGroups}
          >
            {rgLoading ? 'Running AddOrReplaceReadGroups…' : 'Run AddOrReplaceReadGroups'}
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={() => copyToClipboard(rgCmdPreview, setCopied)}
            disabled={rgLoading}
          >
            Copy command
          </button>
        </div>
        {!selectedFolder && (
          <p className="qc-hint">Select or create a patient folder above to enable this.</p>
        )}

        <p className="qc-hint">
          Then index the read-group BAM (creates <code>dedup_rg.bam.bai</code>):
        </p>
        <pre className="qc-cmd align-pre">{indexRgCmdPreview}</pre>
        <div className="qc-actions align-actions-row">
          <button
            type="button"
            className="qc-run"
            onClick={runIndexRgBam}
            disabled={!canRunIndexRg}
          >
            {rgIndexLoading ? 'Indexing…' : 'Run samtools index'}
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={() => copyToClipboard(indexRgCmdPreview, setCopied)}
            disabled={rgIndexLoading}
          >
            Copy command
          </button>
        </div>

        {rgError && <div className="qc-error">{rgError}</div>}
        {rgResult && (
          <div className="qc-success">
            <strong>AddOrReplaceReadGroups complete.</strong>
            <p>
              Output written to: <code>{rgResult.outputBam}</code>
            </p>
          </div>
        )}
      </section>

      <section className="align-section">
        <h3 className="qc-help-title">C. Run HaplotypeCaller</h3>
        <p className="qc-hint">
           Java comes from <code>PICARD_JAVA</code> in <code>backend/.env</code>;
          default jar from <code>GATK_JAR</code>
        </p>

        <div className="qc-field">
          <label htmlFor="vc-gatk-jar">Path to GATK local jar</label>
          <input
            id="vc-gatk-jar"
            type="text"
            className="qc-input"
            placeholder={defaultGatkJar}
            value={gatkJar}
            onChange={(e) => setGatkJar(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
          <p className="qc-hint">
            Preview shows <code>{JAVA_PREVIEW}</code>; the server uses whatever you set for{' '}
            <code>PICARD_JAVA</code>.
          </p>
        </div>

        <div className="qc-field">
          <label htmlFor="vc-ref">Reference FASTA (-R)</label>
          <input
            id="vc-ref"
            type="text"
            className="qc-input"
            placeholder="~/hg38.fa"
            value={refPath}
            onChange={(e) => setRefPath(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
        </div>

        <div className="qc-field">
          <label htmlFor="vc-bam">Input BAM with read groups (-I)</label>
          <input
            id="vc-bam"
            type="text"
            className="qc-input"
            placeholder="~/dedup_rg.bam"
            value={inputBam}
            onChange={(e) => setInputBam(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
        </div>

        <div className="qc-field">
          <label htmlFor="vc-out">Output VCF (-O)</label>
          <input
            id="vc-out"
            type="text"
            className="qc-input"
            placeholder="~/variants.vcf.gz"
            value={outputVcf}
            onChange={(e) => setOutputVcf(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={runLoading}
          />
        </div>

        <pre className="qc-cmd align-pre">{hcPreview}</pre>

        <div className="qc-actions align-actions-row">
          <button type="button" className="qc-run" onClick={runHaplotypeCaller} disabled={!canRun}>
            {runLoading ? 'Running HaplotypeCaller…' : 'Run HaplotypeCaller'}
          </button>
          <button
            type="button"
            className="qc-run"
            onClick={() => copyToClipboard(hcPreview, setCopied)}
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
