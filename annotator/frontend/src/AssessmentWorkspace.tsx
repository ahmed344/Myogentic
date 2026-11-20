import { forwardRef, useImperativeHandle, useState } from 'react'
import { api, assessmentForEditing, assessmentForReview, completionIssue, downloadJson, presenceOptions, withFindingPresence, type CurrentAssessment, type Definitions, type FindingGrade, type Kind, type Presence, type Region, type Saved, type Slide } from './types'
import { useAssessment } from './useAssessment'
import { Viewer } from './Viewer'
import { ConfidenceSlider } from './ConfidenceSlider'

export type WorkspaceHandle = { flush: () => Promise<void> }
type Props = { slide: Slide; reviewer: string; kind: Kind; definitions: Definitions; onSaved: (saved: Saved) => void; onNext: () => void; onViewed: () => void }
type Option = readonly [string, string]
function Select({ label, value, options, onChange, disabled, required, accessibleLabel }: { label: string; value: string; options: readonly Option[]; onChange: (value: string) => void; disabled?: boolean; required?: boolean; accessibleLabel?: string }) {
  return <label className="field"><span>{label}</span><select value={value} disabled={disabled} aria-label={accessibleLabel} aria-required={required} onChange={event => onChange(event.target.value)}>{options.map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label>
}

export const AssessmentWorkspace = forwardRef<WorkspaceHandle, Props>(function AssessmentWorkspace({ slide, reviewer, kind, definitions, onSaved, onNext, onViewed }, ref) {
  const editor = useAssessment(slide.id, reviewer, kind, onSaved)
  const [focus, setFocus] = useState<Region | null>(null)
  const [history, setHistory] = useState<Saved[] | null>(null)
  const [historyError, setHistoryError] = useState('')
  const doc = editor.document ? assessmentForReview(editor.document, definitions) : null
  const completionError = doc ? completionIssue(doc) : ''
  useImperativeHandle(ref, () => ({ flush: editor.flush }), [editor.flush])
  const update = (patch: Partial<CurrentAssessment>) => { if (doc) editor.change(assessmentForEditing({ ...doc, ...patch, status: 'in_progress' }, definitions)) }
  async function complete() {
    if (!doc || !editor.document || completionIssue(doc)) return
    editor.change({ ...assessmentForEditing(editor.document, definitions), status: 'complete' })
    try { await editor.flush(); onNext() } catch { /* Error remains visible next to the save indicator. */ }
  }
  async function openHistory() {
    try {
      await editor.flush()
      setHistory(await api<Saved[]>(`/api/slides/${slide.id}/history?${new URLSearchParams({ reviewer, kind })}`))
    } catch (e) { setHistoryError((e as Error).message) }
  }
  return <>
    <Viewer slideId={slide.id} regions={doc?.regions || []} enabled={!!doc && !!slide.available} focus={focus} onViewed={onViewed} onRegion={region => update({ regions: [...(doc?.regions || []), region] })} />
    <aside className="assessment-panel" aria-label="Annotation">
      <div className="panel-title"><div><p className="eyebrow">{kind === 'adjudicated' ? 'TEAM CONSENSUS' : 'MORPHOLOGY REVIEW'}</p><h2>Annotation</h2></div><span className="version-tag">v{definitions.version}</span></div>
      <div className={`save-status ${editor.error ? 'save-error' : ''}`} role="status"><span className="status-dot" />{editor.state}{editor.revision > 0 && <span className="revision">rev {editor.revision}</span>}</div>
      <div className="assessment-scroll">
        <p className="guidance">Record what you see on this H&amp;E section. More than one pattern may be present.</p>
        {editor.document && editor.document.schema_version !== '2.0' && <p className="notice">This review uses earlier finding categories. Assess the newly separated findings; earlier answers are retained below.</p>}
        {editor.recovered && <p className="notice">Recovered a local draft from this browser.</p>}
        {editor.error && <div className="error-box" role="alert"><p>{editor.error}</p><div className="button-row"><button onClick={() => void editor.flush().catch(() => {})}>Retry save</button><button onClick={() => downloadJson({ slide_id: slide.id, reviewer, kind, expected_revision: editor.revision, assessment: editor.document }, 'myogentic-unsaved-draft.json')}>Export draft</button><button onClick={() => void editor.discardDraft()}>Load saved version</button></div></div>}
        {doc && <fieldset className="assessment-fields" disabled={!slide.available}>
          <section className="form-section"><h3><span>01</span> Overall annotation</h3>
            <Select label="H&E section" value={doc.overall} options={[
              ['unassessed', 'Not yet annotated'], ['no_abnormality_identified', 'No abnormality identified on this H&E section'],
              ['abnormal', 'Abnormality changes identified'], ['uncertain', 'Uncertain'], ['not_assessable', 'Cannot annotate'],
            ]} onChange={value => update({ overall: value as CurrentAssessment['overall'] })} />
            <div className="required-pattern"><Select label="Main pattern (required)" required value={doc.dominant} options={definitions.dominant_options.map(option => [option.id, option.label] as const)} onChange={value => update({ dominant: value as CurrentAssessment['dominant'] })} /></div>
            <Select label="Extent of changes" value={doc.extent} options={[
              ['unassessed', 'Not yet annotated'], ['focal', 'One area (focal)'], ['multifocal', 'Several areas (multifocal)'], ['diffuse', 'Widespread (diffuse)'], ['not_assessable', 'Cannot annotate'],
            ]} onChange={value => update({ extent: value as CurrentAssessment['extent'] })} />
            <ConfidenceSlider label="Confidence" value={doc.certainty} onChange={certainty => update({ certainty })} />
          </section>
          <section className="form-section"><h3><span>02</span> Patterns</h3><p className="section-help">Annotate each pattern separately.</p>
            {definitions.patterns.map(pattern => <div className={`pattern-row ${doc.patterns[pattern.id].presence === 'present' ? 'pattern-present' : ''}`} key={pattern.id}>
              <Select label={pattern.label} value={doc.patterns[pattern.id].presence} options={presenceOptions} onChange={value => update({ patterns: { ...doc.patterns, [pattern.id]: { ...doc.patterns[pattern.id], presence: value as typeof doc.patterns[string]['presence'], severity: 'unassessed' } } })} />
              {['present', 'uncertain'].includes(doc.patterns[pattern.id].presence) && <div className="pattern-details">
                <Select label={`${pattern.label} severity`} value={doc.patterns[pattern.id].severity} options={[
                  ['unassessed', 'Not yet annotated'], ['mild', 'Mild'], ['moderate', 'Moderate'], ['marked', 'Marked'], ['not_applicable', 'Not applicable'],
                ]} onChange={value => update({ patterns: { ...doc.patterns, [pattern.id]: { ...doc.patterns[pattern.id], severity: value as typeof doc.patterns[string]['severity'] } } })} />
                <ConfidenceSlider label={`${pattern.label} confidence`} value={doc.patterns[pattern.id].certainty} onChange={certainty => update({ patterns: { ...doc.patterns, [pattern.id]: { ...doc.patterns[pattern.id], certainty } } })} />
              </div>}
            </div>)}
          </section>
          <section className="form-section"><h3><span>03</span> Visible findings</h3><p className="section-help finding-grade-help">Grade the degree of each finding: 1 Mild · 2 Moderate · 3 Severe. Presence is recorded separately.</p>
            {definitions.findings.map(finding => <div className={`finding-row ${doc.findings[finding.id] === 'present' ? 'finding-present' : ''}`} key={finding.id}>
              <Select label={finding.label} value={doc.findings[finding.id]} options={presenceOptions} onChange={value => {
                const changed = withFindingPresence(doc, finding.id, value as Presence)
                update({ findings: changed.findings, finding_grades: changed.finding_grades })
              }} />
              {finding.help && <p className="finding-help">{finding.help}</p>}
              <div className="finding-grade"><Select label="Grade" accessibleLabel={`${finding.label} grade`} value={doc.finding_grades[finding.id]} options={definitions.finding_grades.map(option => [option.id, option.label] as const)} disabled={!['present', 'uncertain'].includes(doc.findings[finding.id])} onChange={value => update({ finding_grades: { ...doc.finding_grades, [finding.id]: value as FindingGrade } })} /></div>
            </div>)}
            {doc.legacy_findings && <details className="legacy-findings"><summary>Earlier finding annotations</summary><p>Retained with their original meanings. Reassess each new category above.</p><dl>{definitions.migration.retired_findings.map(finding => <div key={finding.id}><dt>{finding.label}</dt><dd>{presenceOptions.find(([value]) => value === doc.legacy_findings?.findings[finding.id])?.[1] || 'Not yet annotated'}</dd></div>)}</dl></details>}
          </section>
          <section className="form-section"><h3><span>04</span> Marked regions &amp; notes</h3>
            <div className="evidence-heading"><span>{doc.regions.length} marked region{doc.regions.length !== 1 ? 's' : ''}</span><kbd>R</kbd></div>
            {!doc.regions.length && <p className="empty-evidence">Use <strong>Mark region</strong> above the slide to show a finding.</p>}
            {doc.regions.map((region, index) => <div className="region-row" key={region.id}><button title="Focus evidence region" onClick={() => setFocus({ ...region })}>E{index + 1}</button><input aria-label={`Evidence ${index + 1} note`} placeholder="What does this region show?" value={region.label} maxLength={500} onChange={event => update({ regions: doc.regions.map(r => r.id === region.id ? { ...r, label: event.target.value } : r) })} /><button className="remove-region" title="Remove region" aria-label={`Remove evidence ${index + 1}`} onClick={() => update({ regions: doc.regions.filter(r => r.id !== region.id) })}>×</button></div>)}
            <label className="field"><span>Comments</span><textarea placeholder="Describe findings, image quality, or questions for the team…" value={doc.comments} maxLength={20000} onChange={event => update({ comments: event.target.value })} rows={4} /></label>
          </section>
          <div className="form-footnote">Findings and grades stay unassessed until you answer. Grades describe the finding; confidence describes certainty. Main pattern is required to complete.</div>
        </fieldset>}
        <button className="text-button" onClick={() => void openHistory()}>View revision history{editor.revision ? ` (${editor.revision})` : ''}</button>
        {historyError && <p className="error-text">{historyError}</p>}
      </div>
      <div className="assessment-footer"><button className="primary-button" disabled={!doc || !!completionError || !slide.available} onClick={() => void complete()}>Complete &amp; next <span>→</span></button><small>{completionError || (doc?.status === 'complete' ? 'Review complete. Editing creates a new draft.' : 'Your progress is saved automatically.')}</small></div>
    </aside>
    {history && <div className="modal-backdrop"><section className="modal history-modal" role="dialog" aria-modal="true" aria-label="Revision history"><div className="modal-title"><h2>Revision history</h2><button onClick={() => setHistory(null)} aria-label="Close revision history">×</button></div><p>{reviewer} · {kind} annotation</p>{history.length ? history.map(item => <details key={item.revision}><summary>Revision {item.revision} · {new Date(item.saved_at!).toLocaleString()} · {item.assessment.status.replace('_', ' ')}</summary><pre>{JSON.stringify(item.assessment, null, 2)}</pre></details>) : <p>No saved revisions yet.</p>}</section></div>}
  </>
})
