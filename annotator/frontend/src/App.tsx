import { useEffect, useRef, useState } from 'react'
import { AssessmentWorkspace, type WorkspaceHandle } from './AssessmentWorkspace'
import { api, type Configuration, type Kind, type Saved, type Slide } from './types'

function cached(key: string) { try { return localStorage.getItem(key) || '' } catch { return '' } }
function cache(key: string, value: string) { try { localStorage.setItem(key, value) } catch { /* Browser storage may be disabled. */ } }
const statusLabel = { unassessed: 'Not yet annotated', in_progress: 'In progress', complete: 'Complete' }

export default function App() {
  const [config, setConfig] = useState<Configuration | null>(null)
  const [theme, setTheme] = useState(() => cached('myogentic:theme') === 'light' ? 'light' : 'dark')
  const [reviewer, setReviewer] = useState(() => cached('myogentic:reviewer'))
  const [reviewerInput, setReviewerInput] = useState(reviewer)
  const [showReviewer, setShowReviewer] = useState(!reviewer)
  const [kind, setKind] = useState<Kind>('individual')
  const [slides, setSlides] = useState<Slide[]>([])
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [limit, setLimit] = useState(80)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [thumbnailVersions, setThumbnailVersions] = useState<Record<string, number>>({})
  const [showHelp, setShowHelp] = useState(false)
  const workspace = useRef<WorkspaceHandle>(null)
  const activeSlide = slides.find(slide => slide.id === selected)
  const visible = slides.filter(slide => (status === 'all' || slide.status === status) && slide.name.toLowerCase().includes(search.trim().toLowerCase()))
  const complete = slides.filter(slide => slide.status === 'complete').length
  const inProgress = slides.filter(slide => slide.status === 'in_progress').length
  const position = activeSlide ? visible.findIndex(slide => slide.id === selected) : -1

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101722' : '#f8f9fb')
    cache('myogentic:theme', theme)
  }, [theme])

  useEffect(() => {
    const controller = new AbortController()
    api<Configuration>('/api/config', { signal: controller.signal }).then(setConfig).catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => controller.abort()
  }, [refresh])

  useEffect(() => {
    if (!reviewer) { setLoading(false); return }
    const controller = new AbortController()
    setLoading(true)
    api<Slide[]>(`/api/slides?${new URLSearchParams({ reviewer, kind })}`, { signal: controller.signal }).then(result => {
      setSlides(result)
      const remembered = cached(`myogentic:last:${reviewer}:${kind}`)
      setSelected(result.some(s => s.id === remembered) ? remembered : result.find(s => s.available)?.id || result[0]?.id || '')
      setLoading(false)
    }).catch(e => { if (e.name !== 'AbortError') { setError(e.message); setLoading(false) } })
    return () => controller.abort()
  }, [reviewer, kind, refresh])

  useEffect(() => { setLimit(80) }, [search, status])

  async function guarded(action: () => void | Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await workspace.current?.flush(); await action(); setError('') }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  function choose(id: string) {
    if (selected === id) return
    void guarded(() => { cache(`myogentic:last:${reviewer}:${kind}`, id); setSelected(id) })
  }
  function nextSlide() {
    const index = slides.findIndex(s => s.id === selected)
    const ordered = [...slides.slice(index + 1), ...slides.slice(0, index)]
    const next = ordered.find(s => s.available && s.status !== 'complete')
    if (next) choose(next.id)
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, button') || event.altKey || event.ctrlKey || event.metaKey || showReviewer || showHelp) return
      if (event.key === ']' && position >= 0 && visible[position + 1]) choose(visible[position + 1].id)
      if (event.key === '[' && position > 0) choose(visible[position - 1].id)
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  })
  function onSaved(saved: Saved) { setSlides(current => current.map(slide => slide.id === selected ? { ...slide, revision: saved.revision, saved_at: saved.saved_at, status: saved.assessment.status } : slide)) }
  async function exportFile(format: string) {
    await guarded(async () => {
      const response = await fetch(`/api/export.${format}`)
      if (!response.ok) throw new Error('Export failed. Please try again.')
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a')
      link.href = url; link.download = `myogentic-${format === 'json' ? 'annotations' : 'summary'}.${format}`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><img className="brand-mark" src="/muscle-hero.svg" alt="" width="64" height="64" /><div><strong>MYOGENTIC</strong><span>Morphology workspace</span></div></div><div className="header-divider" /><span className="workspace-label">Annotator <span className="prototype-tag">PROTOTYPE</span></span>
      <div className="header-actions"><span className="local-badge"><i /> Local workspace</span><button className="theme-toggle" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}><span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span><span>{theme === 'dark' ? 'Light' : 'Dark'}</span></button><button onClick={() => setShowHelp(true)} className="quiet-button" title="Keyboard shortcuts">Shortcuts</button>
        <details className="dropdown"><summary>Export ↓</summary><div className="dropdown-menu"><button onClick={() => void exportFile('json')}>Annotation archive · JSON<small>Hashed slide IDs, all revisions &amp; definitions</small></button><button onClick={() => void exportFile('csv')}>Latest annotations · CSV<small>Hashed slide IDs with the latest reviews</small></button></div></details>
        <button className="reviewer-button" onClick={() => { setReviewerInput(reviewer); setShowReviewer(true) }}><span className="avatar">{reviewer ? reviewer.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase() : '?'}</span>{reviewer || 'Choose reviewer'}</button>
      </div>
    </header>
    {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss message">×</button></div>}
    <div className="workspace-body">
      <aside className="slide-sidebar" aria-label="Slide library">
        <div className="library-heading"><div><p className="eyebrow">YOUR COLLECTION</p><h2>Slide library <span>{slides.length.toLocaleString()}</span></h2></div>
          <button className="refresh-library" title="Refresh slide library" aria-label="Refresh slide library" disabled={busy} onClick={() => void guarded(async () => { await api('/api/rescan', { method: 'POST' }); setRefresh(v => v + 1) })}>↻</button>
        </div>
        <div className="progress-card"><div><strong>{complete}</strong><span> / {slides.length} annotated</span><span>{slides.length ? Math.round(complete / slides.length * 100) : 0}%</span></div><div className="progress-track"><div style={{ width: `${slides.length ? complete / slides.length * 100 : 0}%` }} /></div><small>{inProgress} in progress · {reviewer || 'Choose a reviewer'}</small></div>
        <label className="search-box"><span aria-hidden="true">⌕</span><input aria-label="Search hashed slide IDs" placeholder="Search slide ID…" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <div className="library-filters"><select aria-label="Review status filter" value={status} onChange={e => setStatus(e.target.value)}><option value="all">All statuses</option><option value="unassessed">Not yet annotated</option><option value="in_progress">In progress</option><option value="complete">Complete</option></select><span className="shuffle-label" title="Slides stay in the same shuffled order between sessions">⇄ Mixed order</span></div>
        {config?.scan.warnings.map(w => <p className="library-warning" role="status" key={w}>{w}</p>)}
        <div className="slide-list" aria-label="Slides" aria-busy={loading}>
          {loading ? <p className="list-message">Loading slide library…</p> : visible.length ? visible.slice(0, limit).map(slide => <button className={`slide-card ${slide.id === selected ? 'active' : ''}`} key={slide.id} onClick={() => choose(slide.id)} disabled={busy} aria-current={slide.id === selected ? 'true' : undefined} title={slide.name}>
            <div className="thumbnail">{slide.available ? <img loading="lazy" src={`/api/slides/${slide.id}/thumbnail?v=${thumbnailVersions[slide.id] || 0}`} alt="" onError={e => { e.currentTarget.style.display = 'none' }} /> : <span>Offline</span>}</div><div className="slide-card-text"><strong>{slide.name}</strong><small className={`slide-status ${slide.status}`}><i />{slide.available ? statusLabel[slide.status] : 'Drive unavailable'}</small></div>
          </button>) : <div className="list-message">{reviewer ? 'No matching slides. Check the slide ID, filters, or refresh the library.' : 'Choose a reviewer to begin.'}</div>}
          {visible.length > limit && <button className="load-more" onClick={() => setLimit(v => v + 80)}>Show more slides ({visible.length - limit} remaining)</button>}
        </div>
        <div className="library-footer"><span>{visible.length} matching slides</span><span>Stored locally</span></div>
      </aside>
      <main className="main-workspace">
        <div className="slide-heading"><div><p className="eyebrow">H&amp;E · BLINDED REVIEW</p><h1 className={activeSlide ? 'slide-identifier' : undefined} title={activeSlide?.name}>{activeSlide?.name || 'Choose a slide to begin'}</h1></div><div className="slide-navigation"><select aria-label="Annotation record type" value={kind} disabled={busy} onChange={e => void guarded(() => setKind(e.target.value as Kind))}><option value="individual">Individual review</option><option value="adjudicated">Team consensus</option></select><button disabled={busy || position <= 0} onClick={() => choose(visible[position - 1].id)} title="Previous slide ([)" aria-label="Previous slide">←</button><button disabled={busy || position < 0 || position >= visible.length - 1} onClick={() => choose(visible[position + 1].id)} title="Next slide (])" aria-label="Next slide">→</button></div></div>
        <div className="review-layout">{activeSlide && config && reviewer && !loading ? <AssessmentWorkspace key={`${selected}:${reviewer}:${kind}`} ref={workspace} slide={activeSlide} reviewer={reviewer} kind={kind} definitions={config.definitions} onSaved={onSaved} onNext={nextSlide} onViewed={() => setThumbnailVersions(versions => ({ ...versions, [selected]: (versions[selected] || 0) + 1 }))} /> : <div className="welcome"><img className="welcome-mark" src="/muscle-hero.svg" alt="Myogentic muscle mascot" width="150" height="150" /><p className="eyebrow">OBSERVE · ANNOTATE · REVIEW</p><h2>A closer look at muscle morphology.</h2><p>Open a local whole-slide image and record your observations.<br />Your slides and assessments stay on this computer.</p>{!reviewer && <button className="primary-button" onClick={() => setShowReviewer(true)}>Choose reviewer</button>}{loading && <p>Loading your workspace…</p>}</div>}</div>
      </main>
    </div>
    {showReviewer && <div className="modal-backdrop"><form className="modal reviewer-modal" role="dialog" aria-modal="true" aria-labelledby="reviewer-title" onSubmit={event => { event.preventDefault(); const name = reviewerInput.trim(); if (!name) return; void guarded(() => { cache('myogentic:reviewer', name); setReviewer(name); setShowReviewer(false) }) }}><p className="eyebrow">YOUR ANNOTATION WORKSPACE</p><h2 id="reviewer-title">Who is reviewing?</h2><p>Use the same name or reviewer ID each time. Each reviewer’s annotations and saved versions are kept separately.</p><label className="field"><span>Reviewer name or ID</span><input autoFocus required minLength={1} maxLength={80} pattern="[\p{L}\p{N}_ .@+\-]+" placeholder="e.g. Doctor 01" value={reviewerInput} onChange={e => setReviewerInput(e.target.value)} /></label><small className="modal-note">This is a local reviewer profile, not a sign-in or access control.</small><div className="button-row">{reviewer && <button type="button" onClick={() => setShowReviewer(false)}>Cancel</button>}<button className="primary-button" disabled={!reviewerInput.trim() || busy}>Open workspace →</button></div></form></div>}
    {showHelp && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><div className="modal-title"><h2>Keyboard shortcuts</h2><button onClick={() => setShowHelp(false)} aria-label="Close shortcuts">×</button></div><div className="shortcut"><kbd>R</kbd><span>Mark a region with a rectangle</span></div><div className="shortcut"><kbd>H</kbd><span>Fit the whole slide</span></div><div className="shortcut"><kbd>[</kbd><kbd>]</kbd><span>Previous / next filtered slide</span></div><div className="shortcut"><kbd>Esc</kbd><span>Cancel drawing</span></div><p>Scroll to zoom, drag to move, or double-click to zoom in. Changes save automatically after a short pause.</p><p>Shortcuts are paused while typing in a form.</p></section></div>}
  </div>
}
