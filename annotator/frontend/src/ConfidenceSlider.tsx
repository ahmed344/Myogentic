import { certaintyOptions, type Certainty } from './types'

export function ConfidenceSlider({ label, value, onChange }: { label: string; value: Certainty; onChange: (value: Certainty) => void }) {
  const position = value === 'unassessed' ? 2 : certaintyOptions.findIndex(([key]) => key === value)
  const text = certaintyOptions[position][1]
  return <label className="field confidence-field">
    <span className="confidence-heading"><span>{label}</span><output>{text}{value === 'unassessed' ? ' · default' : ''}</output></span>
    <input type="range" min="0" max="2" step="1" value={position} aria-label={label} aria-valuetext={text}
      onChange={event => onChange(certaintyOptions[Number(event.target.value)][0])} />
    <span className="confidence-stops" aria-hidden="true"><span>Low</span><span>Moderate</span><span>High</span></span>
    {value === 'unassessed' && <small className="confidence-note">Previously not set. High will apply when you edit this review.</small>}
  </label>
}
