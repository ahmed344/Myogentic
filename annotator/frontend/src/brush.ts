import type { Bounds, BrushStroke, Compound, ImagePoint, Region, RegionStroke, RegionTool } from './types'

type SlideSize = { width: number; height: number }
type Geometry = Bounds | BrushStroke | Compound
export const maxRegionStrokes = 512
export const maxStrokePoints = 8192

export function brushOverride(keys: { ctrlKey: boolean; altKey: boolean }): 'paint' | 'erase' | null {
  if (keys.altKey) return 'erase'
  return keys.ctrlKey ? 'paint' : null
}

// A zero-length line with round caps paints a disk for a single-point mark.
export function brushPath(points: ImagePoint[]): string {
  if (points.length === 1) return `M${points[0]}l0,0`
  return 'M' + points.join('L')
}

export function compoundGeometry(region: Geometry | null): Compound {
  if (region && 'shape' in region) {
    if (region.shape === 'compound') return region
    return { shape: 'compound', base: null, strokes: [{ mode: 'paint', points: region.points, diameter: region.diameter }] }
  }
  const base = region && { x: region.x, y: region.y, width: region.width, height: region.height }
  return { shape: 'compound', base, strokes: [] }
}

// Outline clicks and drags extend the same continuous path until another tool makes a mark.
export function addStroke(region: Geometry | null, mode: RegionTool, stroke: BrushStroke): Compound | null {
  if (!region && mode === 'erase') return null
  const { base, strokes } = compoundGeometry(region)
  const last = strokes.at(-1)
  if (mode === 'outline' && last?.mode === 'outline') {
    const endpoint = last.points[last.points.length - 1]
    const first = stroke.points[0]
    const samples = endpoint[0] === first[0] && endpoint[1] === first[1] ? stroke.points.slice(1) : stroke.points
    if (!samples.length) return null
    let points = [...last.points, ...samples]
    while (points.length > maxStrokePoints) points = points.filter((_, i) => i % 2 === 0 || i === points.length - 1)
    return { shape: 'compound', base, strokes: [...strokes.slice(0, -1), { ...last, points }] }
  }
  if (strokes.length >= maxRegionStrokes) return null
  return { shape: 'compound', base, strokes: [...strokes, { mode, points: stroke.points, diameter: stroke.diameter }] }
}

export function closeOutline(region: Geometry | null): Compound | null {
  const geometry = compoundGeometry(region)
  const last = geometry.strokes.at(-1)
  if (!last || (last.mode !== 'outline' && last.mode !== 'paint') || last.points.length < 3) return null
  const [ax, ay] = last.points[0]
  const second = last.points.find(([x, y]) => x !== ax || y !== ay)
  if (!second || !last.points.some(([x, y]) => (second[0] - ax) * (y - ay) !== (second[1] - ay) * (x - ax))) return null
  return { ...geometry, strokes: [...geometry.strokes.slice(0, -1), { ...last, mode: 'fill' }] }
}

export function regionBounds(region: Geometry, slide: SlideSize): Bounds {
  if (!('shape' in region)) return region
  const { base, strokes } = compoundGeometry(region)
  let left = base?.x ?? slide.width, top = base?.y ?? slide.height
  let right = base ? base.x + base.width : 0, bottom = base ? base.y + base.height : 0
  for (const stroke of strokes) {
    if (stroke.mode === 'erase') continue
    const radius = stroke.diameter / 2
    for (const [x, y] of stroke.points) {
      left = Math.min(left, x - radius)
      top = Math.min(top, y - radius)
      right = Math.max(right, x + radius)
      bottom = Math.max(bottom, y + radius)
    }
  }
  left = Math.max(left, 0)
  top = Math.max(top, 0)
  return { x: left, y: top, width: Math.min(right, slide.width) - left, height: Math.min(bottom, slide.height) - top }
}

function strokeContains({ points, diameter, mode }: RegionStroke, [x, y]: ImagePoint): boolean {
  let inside = false
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]
    const [bx, by] = points[i + 1] ?? (mode === 'fill' ? points[0] : points[i])
    const dx = bx - ax, dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0
    if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (diameter / 2) ** 2) return true
    if (mode === 'fill' && (ay > y) !== (by > y) && x < ax + (y - ay) * dx / dy) inside = !inside
  }
  return inside
}

export function regionContains(region: Region, point: ImagePoint): boolean {
  const { base, strokes } = compoundGeometry(region)
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokeContains(strokes[i], point)) return strokes[i].mode !== 'erase'
  }
  return !!base && point[0] >= base.x && point[0] <= base.x + base.width && point[1] >= base.y && point[1] <= base.y + base.height
}
