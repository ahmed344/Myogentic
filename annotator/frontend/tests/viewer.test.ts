import assert from 'node:assert/strict'
import test from 'node:test'
import { scaleBar } from '../src/scale.ts'
import { addStroke, brushPath, closeOutline, regionBounds, regionContains } from '../src/brush.ts'
import { readFileSync } from 'node:fs'
import { assessmentForEditing, assessmentForReview, completionIssue, withFindingPresence, type AssessmentV2, type AssessmentV3, type Definitions, type LegacyAssessment } from '../src/types.ts'

const definitions = JSON.parse(readFileSync(new URL('../../schemas/annotations-v4.3.json', import.meta.url), 'utf8')) as Definitions

test('brush bounds include painted width, clip to the slide, and preserve earlier rectangles', () => {
  const slide = { width: 100, height: 90 }
  const rect = { id: 'old', label: '', x: 2, y: 3, width: 10, height: 20 }
  assert.deepEqual(regionBounds(rect, slide), rect)
  assert.deepEqual(regionBounds({ shape: 'brush', diameter: 8, points: [[10, 30], [80, 10], [4, 0]] }, slide),
    { x: 0, y: 0, width: 84, height: 34 })
  assert.deepEqual(regionBounds({ shape: 'brush', diameter: 8, points: [[99, 89]] }, slide),
    { x: 95, y: 85, width: 5, height: 5 })
  assert.equal(brushPath([[9, 8]]), 'M9,8l0,0')
  assert.equal(brushPath([[1, 2], [4, 5], [2, 7]]), 'M1,2L4,5L2,7')
})

test('multiple strokes edit one geometry and erasure affects only earlier paint', () => {
  const rectangle = { x: 10, y: 10, width: 20, height: 20, id: 'legacy', label: 'original' }
  const stroke = { shape: 'brush' as const, points: [[20, 20]] as [number, number][], diameter: 8 }
  assert.equal(addStroke(null, 'erase', stroke), null)
  const trimmed = { ...addStroke(rectangle, 'erase', stroke)!, id: rectangle.id, label: rectangle.label }
  assert.deepEqual(trimmed.base, { x: 10, y: 10, width: 20, height: 20 })
  assert.equal(regionContains(trimmed, [20, 20]), false)
  assert.equal(regionContains(trimmed, [12, 12]), true)
  const painted = { ...trimmed, ...addStroke(trimmed, 'paint', stroke)! }
  assert.equal(regionContains(painted, [20, 20]), true)
  assert.equal(regionContains(trimmed, [20, 20]), false)
  assert.deepEqual(regionBounds(painted, { width: 100, height: 100 }), trimmed.base)
})

test('outline gestures join and fill is an explicit, reversible geometric change', () => {
  const stroke = (points: [number, number][]) => ({ shape: 'brush' as const, diameter: 2, points })
  const first = addStroke(null, 'outline', stroke([[10, 10], [80, 10]]))!
  assert.equal(closeOutline(first), null)
  assert.equal(closeOutline(addStroke(first, 'outline', stroke([[90, 10]]))), null)
  const open = { ...addStroke(first, 'outline', stroke([[80, 10], [80, 80]]))!, id: 'e1', label: '' }
  assert.equal(open.strokes.length, 1)
  assert.deepEqual(open.strokes[0].points, [[10, 10], [80, 10], [80, 80]])
  assert.equal(regionContains(open, [55, 40]), false)
  const filled = { ...open, ...closeOutline(open)! }
  assert.equal(regionContains(filled, [55, 40]), true)
  assert.equal(regionContains(filled, [45, 45]), true)
  assert.equal(regionContains(filled, [20, 60]), false)
  assert.equal(open.strokes[0].mode, 'outline')
  assert.equal(closeOutline(filled), null)
})

test('physical scale remains accurate at different zoom levels and viewer widths', () => {
  for (const mpp of [0.23, 0.5, 1]) {
    for (const zoom of [0.005, 0.01, 0.1, 0.5, 1, 2]) {
      for (const maxWidth of [60, 120]) {
        const bar = scaleBar(zoom, String(mpp), maxWidth)!
        const [value, unit] = bar.label.split(' ')
        const microns = Number(value.replaceAll(',', '')) * (unit === 'mm' ? 1000 : 1)
        assert.equal(bar.calibrated, true)
        assert.ok(Math.abs(bar.width * mpp / zoom - microns) < 0.000001)
        assert.ok(bar.width <= maxWidth && bar.width >= maxWidth * 0.39)
      }
    }
  }
  assert.equal(scaleBar(0.01, '0.5')!.label, '5 mm')
  assert.equal(scaleBar(1, '0.5')!.label, '50 µm')
})

test('missing or invalid calibration always shows original image pixels', () => {
  for (const mpp of [null, '', '0', '-1', 'NaN', 'Infinity']) {
    const bar = scaleBar(0.5, mpp)!
    assert.equal(bar.calibrated, false)
    assert.equal(bar.label, '200 px')
    assert.equal(bar.width, 100)
  }
  for (const zoom of [0, -1, NaN, Infinity]) assert.equal(scaleBar(zoom, '0.5'), null)
})

test('Copenhagen OME calibration gives a real micrometre ruler', () => {
  const bar = scaleBar(0.16, '0.168942')!
  assert.equal(bar.label, '100 µm')
  assert.equal(bar.calibrated, true)
  assert.ok(Math.abs(bar.width / 0.16 * 0.168942 - 100) < 0.000001)
})

test('editing a legacy review preserves explicit confidence and unanswered findings', () => {
  const original = { schema_version: '1.0', certainty: 'unassessed', overall: 'unassessed',
    dominant: 'none', findings: { fiber_size_variation: 'unassessed', internal_nuclei: 'present', necrosis_regeneration: 'present', grouped_atrophy: 'present', inflammatory_infiltrate: 'absent', fibrosis_adipose: 'uncertain' }, patterns: {
      myopathic: { presence: 'present', severity: 'mild', certainty: 'low' },
      neurogenic: { presence: 'unassessed', severity: 'unassessed', certainty: 'unassessed' },
    } } as LegacyAssessment
  const edited = assessmentForEditing(original, definitions)
  assert.equal(edited.schema_version, '4.3')
  assert.equal(edited.certainty, 'high')
  assert.equal(edited.patterns.myopathic.certainty, 'low')
  assert.equal(edited.patterns.neurogenic.certainty, 'high')
  assert.equal(edited.patterns.neurogenic.presence, 'unassessed')
  assert.equal(edited.findings.fiber_size_variation, 'unassessed')
  assert.equal(edited.findings.perimysial, 'unassessed')
  assert.equal(edited.findings.fibrosis_adipose, 'uncertain')
  assert.equal(edited.findings.internal_nuclei_noncentered, 'unassessed')
  assert.equal(edited.findings.centered_nuclei, 'unassessed')
  for (const key of ['necrosis', 'regeneration', 'rounded_atrophy', 'angular_atrophy', 'perifascicular_atrophy']) {
    assert.equal(edited.findings[key], 'unassessed')
    assert.equal(edited.finding_grades[key], 'unassessed')
  }
  assert.deepEqual(edited.legacy_findings, { schema_version: '1.0', findings: original.findings })
  assert.equal(edited.dominant, 'unassessed')
  assert.equal(assessmentForReview(original, definitions).certainty, 'unassessed')
  assert.equal(original.certainty, 'unassessed')
  assert.equal(original.patterns.neurogenic.certainty, 'unassessed')
  assert.equal(original.schema_version, '1.0')
})

test('v2 nuclear types carry explicit positives and preserve the original individual grades', () => {
  const v2 = { schema_version: '2.0', dominant: 'myopathic', certainty: 'high', patterns: {},
    findings: { internal_nuclei_noncentered: 'present', centered_nuclei: 'present', inflammatory_infiltrate: 'present' },
    finding_grades: { internal_nuclei_noncentered: 'grade_1', centered_nuclei: 'grade_3', inflammatory_infiltrate: 'grade_2' },
    legacy_findings: { schema_version: '1.1', findings: { grouped_atrophy: 'uncertain' } } } as AssessmentV2
  const current = assessmentForEditing(v2, definitions)
  assert.equal(current.findings.internal_nuclei_noncentered, 'present')
  assert.equal(current.finding_grades.internal_nuclei_noncentered, 'grade_1')
  assert.equal(current.finding_grades.centered_nuclei, 'grade_3')
  assert.equal(current.findings.perimysial, 'unassessed')
  assert.equal(current.finding_grades.perimysial, 'unassessed')
  assert.deepEqual(current.legacy_findings, { schema_version: '2.0', findings: v2.findings, finding_grades: v2.finding_grades, legacy_findings: v2.legacy_findings })
  const changed = withFindingPresence(current, 'centered_nuclei', 'absent')
  assert.equal(changed.finding_grades.centered_nuclei, 'not_applicable')
  assert.equal(changed.finding_grades.internal_nuclei_noncentered, 'grade_1')
})

test('v3 selections preserve uncertainty while shared grades stay in the original snapshot', () => {
  const v3 = { schema_version: '3.0', dominant: 'uncertain', certainty: 'high', patterns: {},
    findings: { internal_nuclei: 'present', inflammatory_infiltrate: 'uncertain', necrosis: 'present' },
    finding_grades: { internal_nuclei: 'grade_2', inflammatory_infiltrate: 'grade_3', necrosis: 'grade_1' },
    finding_types: { internal_nuclei: ['centered_nuclei'], inflammatory_infiltrate: ['perimysial', 'perivascular'] },
    legacy_findings: null } as AssessmentV3
  const current = assessmentForEditing(v3, definitions)
  assert.equal(current.findings.centered_nuclei, 'present')
  assert.equal(current.findings.internal_nuclei_noncentered, 'unassessed')
  assert.equal(current.findings.endomysial, 'unassessed')
  assert.equal(current.findings.perimysial, 'uncertain')
  assert.equal(current.findings.perivascular, 'uncertain')
  for (const id of ['centered_nuclei', 'internal_nuclei_noncentered', 'perimysial', 'endomysial', 'perivascular']) {
    assert.equal(current.finding_grades[id], 'unassessed')
  }
  assert.equal(current.finding_grades.necrosis, 'grade_1')
  assert.deepEqual(current.legacy_findings, { schema_version: '3.0', findings: v3.findings, finding_grades: v3.finding_grades, finding_types: v3.finding_types, legacy_findings: null })
  assert.equal('finding_types' in current, false)
  assert.equal('internal_nuclei' in current.finding_grades, false)
})

test('grouping atrophy keeps each earlier assessment attached to its type', () => {
  const findings = { rounded_atrophy: 'present', angular_atrophy: 'uncertain', perifascicular_atrophy: 'absent' } as const
  const finding_grades = { rounded_atrophy: 'grade_3', angular_atrophy: 'grade_1', perifascicular_atrophy: 'not_applicable' } as const
  const v2 = { schema_version: '2.0', dominant: 'myopathic', findings, finding_grades, legacy_findings: null } as AssessmentV2
  const v3 = { ...v2, schema_version: '3.0', finding_types: { internal_nuclei: [], inflammatory_infiltrate: [] } } as AssessmentV3
  const v4 = { ...assessmentForReview(v3, definitions), schema_version: '4.0' } as const
  for (const previous of [v2, v3, v4]) {
    const review = assessmentForReview(previous, definitions)
    for (const id of Object.keys(findings) as (keyof typeof findings)[]) {
      assert.equal(review.findings[id], findings[id])
      assert.equal(review.finding_grades[id], finding_grades[id])
    }
    const edited = withFindingPresence(review, 'angular_atrophy', 'absent')
    assert.equal(edited.finding_grades.angular_atrophy, 'not_applicable')
    assert.equal(edited.finding_grades.rounded_atrophy, 'grade_3')
    assert.equal(review.finding_grades.angular_atrophy, 'grade_1')
  }
  assert.deepEqual(assessmentForReview(v4, definitions), { ...v4, schema_version: '4.3' })
})

test('completion requires a main pattern while explicit no-pattern and uncertainty remain valid', () => {
  const legacy = { schema_version: '1.1', status: 'complete', overall: 'abnormal', dominant: 'none', certainty: 'high', patterns: {}, findings: {} } as LegacyAssessment
  const current = assessmentForEditing(legacy, definitions)
  assert.match(completionIssue(current), /main pattern/)
  for (const dominant of ['myopathic', 'mixed', 'no_dominant_pattern', 'uncertain', 'not_assessable'] as const) {
    assert.equal(completionIssue({ ...current, dominant }), '')
  }
  assert.match(completionIssue({ ...current, dominant: 'myopathic', overall: 'unassessed' }), /overall/)
})

test('finding grades are independent and are cleared when presence no longer supports grading', () => {
  const current = assessmentForReview({ schema_version: '1.1', findings: {}, dominant: 'none' } as LegacyAssessment, definitions)
  let edited = withFindingPresence(current, 'necrosis', 'present')
  edited = { ...edited, finding_grades: { ...edited.finding_grades, necrosis: 'grade_3' } }
  assert.equal(edited.findings.regeneration, 'unassessed')
  assert.equal(edited.finding_grades.regeneration, 'unassessed')
  assert.equal(withFindingPresence(edited, 'necrosis', 'uncertain').finding_grades.necrosis, 'grade_3')
  assert.equal(withFindingPresence(edited, 'necrosis', 'absent').finding_grades.necrosis, 'not_applicable')
  assert.equal(withFindingPresence(edited, 'necrosis', 'unassessed').finding_grades.necrosis, 'unassessed')
  assert.equal(withFindingPresence(edited, 'necrosis', 'not_assessable').finding_grades.necrosis, 'unassessed')
  const absent = withFindingPresence(edited, 'necrosis', 'absent')
  assert.equal(withFindingPresence(absent, 'necrosis', 'present').finding_grades.necrosis, 'unassessed')
  assert.equal(edited.finding_grades.necrosis, 'grade_3')
  assert.strictEqual(assessmentForReview(edited, definitions), edited)
})
