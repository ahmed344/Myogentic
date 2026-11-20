import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Assessment, type CurrentAssessment, type Kind, type Saved } from './types'

type Draft = { expected_revision: number; assessment: Assessment }
export function useAssessment(slideId: string, reviewer: string, kind: Kind, onSaved: (saved: Saved) => void) {
  const path = `/api/slides/${slideId}/assessment?${new URLSearchParams({ reviewer, kind })}`
  const draftKey = `myogentic:draft:${slideId}:${reviewer}:${kind}`
  const [document, setDocument] = useState<Assessment | null>(null)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState('Loading annotation…')
  const [error, setError] = useState('')
  const [recovered, setRecovered] = useState(false)
  const current = useRef<Assessment | null>(null)
  const version = useRef(0), savedVersion = useRef(0), revisionRef = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)
  const blocked = useRef(false)
  const mounted = useRef(true)
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved

  const remember = useCallback(() => {
    if (!current.current) return
    try { localStorage.setItem(draftKey, JSON.stringify({ expected_revision: revisionRef.current, assessment: current.current })) }
    catch { /* beforeunload still protects unsaved edits when browser storage is unavailable. */ }
  }, [draftKey])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    api<Saved>(path, { signal: controller.signal }).then(saved => {
      revisionRef.current = saved.revision; setRevision(saved.revision)
      let draft: Draft | null = null
      try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { /* Invalid browser cache. */ }
      const restored = draft && ['1.0', '1.1', '2.0'].includes(draft.assessment?.schema_version) ? draft : null
      current.current = restored ? restored.assessment : saved.assessment
      setDocument(current.current)
      if (restored) {
        version.current = 1; setRecovered(true); setState('Unsaved changes')
        if (restored.expected_revision !== saved.revision) {
          blocked.current = true
          setError('A saved revision changed while this local draft was pending. Export the draft before loading the saved version.')
        }
      } else setState(saved.revision ? 'All changes saved' : 'Ready to annotate')
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => { mounted.current = false; controller.abort() }
  }, [path, draftKey])

  const flush = useCallback(async () => {
    if (blocked.current) throw new Error('Resolve the draft conflict before continuing.')
    if (!current.current) return
    if (inFlight.current) return inFlight.current
    const operation = async () => {
      while (savedVersion.current < version.current) {
        const savingVersion = version.current
        const snapshot = current.current!
        if (mounted.current) { setState('Saving…'); setError('') }
        try {
          const saved = await api<Saved>(path, { method: 'PUT', body: JSON.stringify({ expected_revision: revisionRef.current, assessment: snapshot }) })
          revisionRef.current = saved.revision; savedVersion.current = savingVersion
          if (savedVersion.current === version.current) {
            try { localStorage.removeItem(draftKey) } catch { /* Storage may be disabled. */ }
          }
          else remember()
          if (mounted.current) { setRevision(saved.revision); setRecovered(false); savedCallback.current(saved) }
        } catch (e) {
          remember()
          if (mounted.current) { setError((e as Error).message); setState('Not saved') }
          throw e
        }
      }
      if (mounted.current) setState('All changes saved')
    }
    inFlight.current = operation()
    try { await inFlight.current } finally { inFlight.current = null }
  }, [path, draftKey, remember])

  const change = useCallback((next: CurrentAssessment) => {
    current.current = next; version.current += 1; setDocument(next); setState('Unsaved changes'); remember()
  }, [remember])

  useEffect(() => {
    if (!document || savedVersion.current === version.current || blocked.current) return
    const timeout = setTimeout(() => { void flush().catch(() => {}) }, 700)
    return () => clearTimeout(timeout)
  }, [document, flush])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (version.current > savedVersion.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  async function discardDraft() {
    if (!window.confirm('Discard this unsaved local draft and load the saved annotation? Export it first if you need to retain it.')) return
    try {
      const saved = await api<Saved>(path)
      current.current = saved.assessment; revisionRef.current = saved.revision
      version.current = 0; savedVersion.current = 0; blocked.current = false
      try { localStorage.removeItem(draftKey) } catch { /* Storage may be disabled. */ }
      setDocument(saved.assessment); setRevision(saved.revision)
      setError(''); setRecovered(false); setState(saved.revision ? 'All changes saved' : 'Ready to annotate')
    } catch (e) { setError((e as Error).message) }
  }
  return { document, change, flush, revision, state, error, recovered, discardDraft }
}
