import assert from 'node:assert/strict'
import test from 'node:test'
import { scaleBar } from '../src/scale.ts'
import { readFileSync } from 'node:fs'
import { assessmentForEditing, assessmentForReview, completionIssue, withFindingPresence, type Definitions, type LegacyAssessment } from '../src/types.ts'

const definitions = JSON.parse(readFileSync(new URL('../../schemas/annotations-v2.json', import.meta.url), 'utf8')) as Definitions

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
  assert.equal(edited.schema_version, '2.0')
  assert.equal(edited.certainty, 'high')
  assert.equal(edited.patterns.myopathic.certainty, 'low')
  assert.equal(edited.patterns.neurogenic.certainty, 'high')
  assert.equal(edited.patterns.neurogenic.presence, 'unassessed')
  assert.equal(edited.findings.fiber_size_variation, 'unassessed')
  assert.equal(edited.findings.inflammatory_infiltrate, 'absent')
  assert.equal(edited.findings.fibrosis_adipose, 'uncertain')
  for (const key of ['internal_nuclei_noncentered', 'centered_nuclei', 'necrosis', 'regeneration', 'rounded_atrophy', 'angular_atrophy', 'perifascicular_atrophy']) {
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
