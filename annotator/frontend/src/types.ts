export type Presence = 'unassessed' | 'present' | 'absent' | 'uncertain' | 'not_assessable'
export type Severity = 'unassessed' | 'mild' | 'moderate' | 'marked' | 'not_applicable'
export type Certainty = 'unassessed' | 'low' | 'moderate' | 'high'
export type FindingGrade = 'unassessed' | 'grade_1' | 'grade_2' | 'grade_3' | 'not_applicable'
export type Kind = 'individual' | 'adjudicated'
export type Region = { id: string; label: string; x: number; y: number; width: number; height: number }
export type Pattern = { presence: Presence; severity: Severity; certainty: Certainty }
type AssessmentFields = {
  status: 'in_progress' | 'complete'
  overall: 'unassessed' | 'no_abnormality_identified' | 'abnormal' | 'uncertain' | 'not_assessable'
  extent: 'unassessed' | 'focal' | 'multifocal' | 'diffuse' | 'not_assessable'
  certainty: Certainty
  patterns: Record<string, Pattern>; findings: Record<string, Presence>; comments: string; regions: Region[]
}
type PatternChoice = 'myopathic' | 'dystrophic' | 'inflammatory' | 'neurogenic' | 'mixed' | 'uncertain'
export type LegacyAssessment = AssessmentFields & { schema_version: '1.0' | '1.1'; dominant: 'none' | PatternChoice }
export type LegacyFindings = { schema_version: '1.0' | '1.1'; findings: Record<string, Presence> }
export type CurrentAssessment = AssessmentFields & {
  schema_version: '2.0'; dominant: 'unassessed' | 'no_dominant_pattern' | 'not_assessable' | PatternChoice
  finding_grades: Record<string, FindingGrade>; legacy_findings: LegacyFindings | null
}
export type Assessment = LegacyAssessment | CurrentAssessment
export type Saved = { revision: number; saved_at: string | null; assessment: Assessment }
export type Slide = {
  id: string; name: string; available: number
  status: 'unassessed' | 'in_progress' | 'complete'; revision: number | null; saved_at: string | null
}
type DefinitionOption = { id: string; label: string; help?: string }
export type Definitions = {
  version: string; principle: string; patterns: DefinitionOption[]; findings: DefinitionOption[]
  finding_grades: DefinitionOption[]; dominant_options: DefinitionOption[]
  migration: { from_versions: string[]; carry_findings: string[]; retired_findings: DefinitionOption[] }
}
export type Configuration = { definitions: Definitions; scan: { indexed: number; warnings: string[] } }
export type SlideInfo = { width: number; height: number; mpp: string | null; mpp_y: string | null; calibration_source: string | null; objective: string | null; levels: number }

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Myogentic-Client': 'annotator', ...options?.headers } })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json()
      message = typeof body.detail === 'string' ? body.detail : body.detail?.map((e: { msg: string }) => e.msg).join('; ') || message
    } catch { /* Keep HTTP status for non-JSON errors. */ }
    throw new Error(message)
  }
  return response.json()
}

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const presenceOptions = [
  ['unassessed', 'Not yet annotated'], ['present', 'Present'], ['absent', 'Absent'],
  ['uncertain', 'Uncertain'], ['not_assessable', 'Cannot annotate'],
] as const
export const certaintyOptions = [['low', 'Low'], ['moderate', 'Moderate'], ['high', 'High']] as const

// Pure display projection: the loaded record and its revision remain untouched.
// Redefined/split categories start unassessed; never copy a combined answer into
// its parts. The snapshot also preserves earlier browser-only drafts on edit.
export function assessmentForReview(document: Assessment, definitions: Definitions): CurrentAssessment {
  if (document.schema_version === '2.0') return document
  const findings: Record<string, Presence> = Object.fromEntries(definitions.findings.map(finding => [finding.id,
    definitions.migration.carry_findings.includes(finding.id) ? document.findings[finding.id] ?? 'unassessed' : 'unassessed']))
  return { ...document, schema_version: '2.0', dominant: document.dominant === 'none' ? 'unassessed' : document.dominant,
    findings, finding_grades: Object.fromEntries(Object.entries(findings).map(([id, presence]) => [id, presence === 'absent' ? 'not_applicable' : 'unassessed'])),
    legacy_findings: { schema_version: document.schema_version, findings: { ...document.findings } } }
}

// Confidence defaults apply only when the reviewer explicitly edits or completes.
export function assessmentForEditing(document: Assessment, definitions: Definitions): CurrentAssessment {
  return { ...assessmentForReview(document, definitions), certainty: document.certainty === 'unassessed' ? 'high' : document.certainty,
    patterns: Object.fromEntries(Object.entries(document.patterns).map(([key, pattern]) =>
      [key, { ...pattern, certainty: pattern.certainty === 'unassessed' ? 'high' : pattern.certainty }])) }
}

export function completionIssue(document: CurrentAssessment): string {
  if (document.overall === 'unassessed') return 'Choose an overall annotation to complete.'
  if (document.dominant === 'unassessed') return 'Choose a main pattern to complete.'
  return ''
}

export function withFindingPresence(document: CurrentAssessment, id: string, presence: Presence): CurrentAssessment {
  const grade = ['present', 'uncertain'].includes(presence)
    ? (['present', 'uncertain'].includes(document.findings[id]) ? document.finding_grades[id] : 'unassessed')
    : presence === 'absent' ? 'not_applicable' : 'unassessed'
  return { ...document, findings: { ...document.findings, [id]: presence }, finding_grades: { ...document.finding_grades, [id]: grade } }
}
