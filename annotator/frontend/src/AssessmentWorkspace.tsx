import { forwardRef, useImperativeHandle, useState } from 'react'
import { api, assessmentForEditing, assessmentForReview, completionIssue, downloadJson, presenceOptions, withFindingPresence, type CurrentAssessment, type DefinitionOption, type HistoricalVocabulary, type Definitions, type FindingGrade, type Kind, type Presence, type Region, type Saved, type Slide } from './types'
import { useAssessment } from './useAssessment'
import { Viewer } from './Viewer'
import { useRegionEditor } from './useRegionEditor'
import { ConfidenceSlider } from './ConfidenceSlider'

export type WorkspaceHandle = { flush: () => Promise<void> }
type Props = { slide: Slide; reviewer: string; kind: Kind; definitions: Definitions; definitionVersions: Record<string, HistoricalVocabulary>; onSaved: (saved: Saved) => void; onNext: () => void; onViewed: () => void }
type Option = readonly [string, string]
function Select({ label, value, options, onChange, disabled, required, accessibleLabel }: { label: string; value: string; options: readonly Option[]; onChange: (value: string) => void; disabled?: boolean; required?: boolean; accessibleLabel?: string }) {
  return <label className="field"><span>{label}</span><select value={value} disabled={disabled} aria-label={accessibleLabel} aria-required={required} onChange={event => onChange(event.target.value)}>{options.map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label>
}

function EarlierFindings({ snapshot, versions }: { snapshot: NonNullable<CurrentAssessment['legacy_findings']>; versions: Props['definitionVersions'] }) {
  const vocabulary = versions[snapshot.schema_version]
  const graded = 'finding_grades' in snapshot
  const answered = vocabulary.findings.filter(({ id }) => snapshot.findings[id] !== 'unassessed' || (graded && snapshot.finding_grades[id] !== 'unassessed'))
  return <>
    <p>Vocabulary v{snapshot.schema_version}</p>
    {answered.length ? <dl>{answered.map(({ id, label, types }) => {
      const presence = presenceOptions.find(([value]) => value === snapshot.findings[id])?.[1]
      const grade = graded && vocabulary.finding_grades?.find(option => option.id === snapshot.finding_grades[id])
      const selected = snapshot.schema_version === '3.0' ? snapshot.finding_types[id] : undefined
      const typeLabels = types?.filter(type => selected?.includes(type.id)).map(type => type.label) ?? []
      return <div key={id}><dt>{label}</dt><dd>{[presence, ...typeLabels, grade && grade.label].filter(Boolean).join(' · ')}</dd></div>
    })}</dl> : <p>No findings recorded.</p>}
    {'legacy_findings' in snapshot && snapshot.legacy_findings && <EarlierFindings snapshot={snapshot.legacy_findings} versions={versions} />}
  </>
}

type FindingControlsProps = {
  item: DefinitionOption; document: CurrentAssessment; grades: Definitions['finding_grades']
  grouped?: boolean; update: (patch: Partial<CurrentAssessment>) => void
}

function FindingControls({ item, document, grades, grouped, update }: FindingControlsProps) {
  const presence = document.findings[item.id]
  const gradeLabel = `${item.label} grade`
  return <div className={grouped ? 'finding-type-row' : `finding-row ${presence === 'present' ? 'finding-present' : ''}`}>
    {grouped && <div className="finding-type-name"><strong>{item.label}</strong>{item.help && <small>{item.help}</small>}</div>}
    <Select label={grouped ? 'Presence' : item.label} accessibleLabel={grouped ? `${item.label} presence` : item.label}
      value={presence} options={presenceOptions} onChange={value => {
        const { findings, finding_grades } = withFindingPresence(document, item.id, value as Presence)
        update({ findings, finding_grades })
      }} />
    {!grouped && item.help && <p className="finding-help">{item.help}</p>}
    <div className="finding-grade"><Select label="Grade" accessibleLabel={gradeLabel} value={document.finding_grades[item.id]}
      options={grades.map(option => [option.id, option.label] as const)} disabled={!['present', 'uncertain'].includes(presence)}
      onChange={value => update({ finding_grades: { ...document.finding_grades, [item.id]: value as FindingGrade } })} /></div>
  </div>
}

export const AssessmentWorkspace = forwardRef<WorkspaceHandle, Props>(function AssessmentWorkspace({ slide, reviewer, kind, definitions, definitionVersions, onSaved, onNext, onViewed }, ref) {
  const editor = useAssessment(slide.id, reviewer, kind, onSaved)
  const [focus, setFocus] = useState<Region | null>(null)
  const [history, setHistory] = useState<Saved[] | null>(null)
  const [historyError, setHistoryError] = useState('')
  const doc = editor.document ? assessmentForReview(editor.document, definitions) : null
  const completionError = doc ? completionIssue(doc) : ''
  useImperativeHandle(ref, () => ({ flush: editor.flush }), [editor.flush])
  const update = (patch: Partial<CurrentAssessment>) => { if (doc) editor.change(assessmentForEditing({ ...doc, ...patch, status: 'in_progress' }, definitions)) }
  const regionEditor = useRegionEditor(doc?.regions ?? [], regions => update({ regions }))
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
    <Viewer slideId={slide.id} regions={doc?.regions ?? []} enabled={!!doc && !!slide.available} focus={focus} onViewed={onViewed} editor={regionEditor} />
    <aside className="assessment-panel" aria-label="Annotation">
      <div className="panel-title"><div><p className="eyebrow">{kind === 'adjudicated' ? 'TEAM CONSENSUS' : 'MORPHOLOGY REVIEW'}</p><h2>Annotation</h2></div><span className="version-tag">v{definitions.version}</span></div>
      <div className={`save-status ${editor.error ? 'save-error' : ''}`} role="status"><span className="status-dot" />{editor.state}{editor.revision > 0 && <span className="revision">rev {editor.revision}</span>}</div>
      <div className="assessment-scroll">
        <p className="guidance">Record what you see on this H&amp;E section. More than one pattern may be present.</p>
        {editor.document && editor.document.schema_version !== definitions.version && <p className="notice">Review saved with v{editor.document.schema_version}. Your next edit will use v{definitions.version}.{doc?.legacy_findings && ' See earlier finding annotations below.'}</p>}
        {editor.recovered && <p className="notice">Recovered a local draft from this browser.</p>}
        {editor.error && <div className="error-box" role="alert"><p>{editor.error}</p><div className="button-row"><button onClick={() => void editor.flush().catch(() => {})}>Retry save</button><button onClick={() => downloadJson({ slide_id: slide.id, reviewer, kind, expected_revision: editor.revision, assessment: editor.document }, 'myogentic-unsaved-draft.json')}>Export draft</button><button onClick={async () => { if (await editor.discardDraft()) regionEditor.reset() }}>Load saved version</button></div></div>}
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
          <section className="form-section"><h3><span>03</span> Visible findings</h3><p className="section-help finding-grade-help">Grade each finding or type separately. Grade 1 · Mild, 2 · Moderate, 3 · Severe.</p>
            {definitions.findings.map(finding => finding.types ? <fieldset className="finding-group" key={finding.id}>
              <legend>{finding.label}</legend>
              {finding.types.map(type => <FindingControls key={type.id} item={type} grouped document={doc} grades={definitions.finding_grades} update={update} />)}
            </fieldset> : <FindingControls key={finding.id} item={finding} document={doc} grades={definitions.finding_grades} update={update} />)}
            {doc.legacy_findings && <details className="legacy-findings"><summary>Earlier finding annotations</summary>
              <EarlierFindings snapshot={doc.legacy_findings} versions={definitionVersions} />
            </details>}
          </section>
          <section className="form-section"><h3><span>04</span> Marked regions &amp; notes</h3>
            <div className="evidence-heading"><span>{doc.regions.length} marked region{doc.regions.length !== 1 ? 's' : ''}</span><kbd>R</kbd></div>
            {!doc.regions.length && <p className="empty-evidence">Use the <strong>Brush</strong> above the slide to mark a finding.</p>}
            {doc.regions.map((region, index) => <div className="region-row" key={region.id}>
              <button title="Select and focus this region" aria-pressed={regionEditor.selected?.id === region.id}
                onClick={() => { regionEditor.select(region.id); regionEditor.setTool(null); setFocus({ ...region }) }}>E{index + 1}</button>
              <input aria-label={`Evidence ${index + 1} note`} placeholder="What does this region show?" value={region.label} maxLength={500}
                onChange={event => update({ regions: doc.regions.map(r => r.id === region.id ? { ...r, label: event.target.value } : r) })} />
              <button aria-label={`Edit evidence ${index + 1}`} onClick={() => { setFocus({ ...region }); regionEditor.select(region.id); regionEditor.setTool('paint') }}>Edit</button>
              <button className="remove-region" title="Delete region" aria-label={`Delete evidence ${index + 1}`} onClick={() => regionEditor.remove(region.id)}>×</button>
            </div>)}
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
