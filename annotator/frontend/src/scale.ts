export type ScaleBar = { width: number; label: string; calibrated: boolean }

// The viewer reports CSS pixels per original image pixel. Use horizontal MPP
// for this horizontal ruler; never infer calibration from objective power.
export function scaleBar(imageZoom: number, mpp: string | null, maxWidth = 120): ScaleBar | null {
  if (!Number.isFinite(imageZoom) || imageZoom <= 0 || maxWidth <= 0) return null
  const micronsPerPixel = Number(mpp)
  const calibrated = Number.isFinite(micronsPerPixel) && micronsPerPixel > 0
  const unitsPerScreenPixel = (calibrated ? micronsPerPixel : 1) / imageZoom
  const target = maxWidth * unitsPerScreenPixel
  const power = 10 ** Math.floor(Math.log10(target))
  const length = [5, 2, 1].map(n => n * power).find(n => n <= target)!
  const value = calibrated && length >= 1000 ? length / 1000 : length
  const unit = calibrated ? (length >= 1000 ? 'mm' : 'µm') : 'px'
  return { width: length / unitsPerScreenPixel, label: `${Number(value.toPrecision(3)).toLocaleString('en-US')} ${unit}`, calibrated }
}
