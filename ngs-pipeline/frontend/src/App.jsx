import { useState } from 'react'
import { AlignmentPanel } from './components/AlignmentPanel.jsx'
import { DownstreamAnalysisPanel } from './components/DownstreamAnalysisPanel.jsx'
import { OverviewPanel } from './components/OverviewPanel.jsx'
import { PostAlignmentPanel } from './components/PostAlignmentPanel.jsx'
import { QualityControlPanel } from './components/QualityControlPanel.jsx'
import { ReadTrimmingPanel } from './components/ReadTrimmingPanel.jsx'
import { VariantAnnotationPanel } from './components/VariantAnnotationPanel.jsx'
import { VariantCallingPanel } from './components/VariantCallingPanel.jsx'
import { MENU_SECTIONS } from './menuSections.js'
import { RootDirProvider } from './RootDirContext.jsx'
import './App.css'

function App() {
  const [activeId, setActiveId] = useState(MENU_SECTIONS[0].id)
  const active = MENU_SECTIONS.find((s) => s.id === activeId) ?? MENU_SECTIONS[0]

  return (
    <RootDirProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-label="Pipeline steps">
        <header className="sidebar-header">
          <div className="sidebar-title-row">
            <h1 className="app-title">NGS pipeline</h1>
            <img src="/image.png" alt="" className="sidebar-inst-logo" />
            <img src="/office2405202514_32_33.jpg" alt="" className="sidebar-inst-logo" />
          </div>
          <p className="app-subtitle">Workflow steps</p>
        </header>
        <nav className="sidebar-nav">
          <ul className="nav-list">
            {MENU_SECTIONS.map((section) => {
              const isActive = section.id === activeId
              return (
                <li key={section.id}>
                  <button
                    type="button"
                    className={`nav-item${isActive ? ' nav-item--active' : ''}`}
                    onClick={() => setActiveId(section.id)}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    {section.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
      </aside>

      <main className="main-panel">
        <header className="main-header">
          <h2 className="main-title">{active.label}</h2>
        </header>
        <div className="main-body">
          {active.id === 'overview' ? (
            <OverviewPanel />
          ) : active.id === 'quality-control' ? (
            <QualityControlPanel />
          ) : active.id === 'read-trimming' ? (
            <ReadTrimmingPanel />
          ) : active.id === 'alignment' ? (
            <AlignmentPanel />
          ) : active.id === 'post-alignment' ? (
            <PostAlignmentPanel />
          ) : active.id === 'variant-calling' ? (
            <VariantCallingPanel />
          ) : active.id === 'variant-annotation' ? (
            <VariantAnnotationPanel />
          ) : active.id === 'downstream' ? (
            <DownstreamAnalysisPanel />
          ) : (
            <p className="main-placeholder">
              Content and actions for this step will go here. Switch sections using the menu on the
              left.
            </p>
          )}
        </div>
      </main>
    </div>
    </RootDirProvider>
  )
}

export default App
