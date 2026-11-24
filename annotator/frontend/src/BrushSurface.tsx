import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import OpenSeadragon from 'openseadragon'
import { addStroke, brushOverride, compoundGeometry, maxStrokePoints } from './brush'
import { RegionInk } from './RegionGraphic'
import type { BrushStroke, ImagePoint, Region, RegionTool, SlideInfo } from './types'

type Props = {
  viewer: OpenSeadragon.Viewer; slide: SlideInfo; size: number; outlineDiameter: number | null
  region: Region | null; tool: RegionTool; effectiveTool: RegionTool; atStrokeLimit: boolean
  onOverride: (mode: ReturnType<typeof brushOverride>) => void
  onDrawing: (mode: RegionTool | null) => void
  onStroke: (mode: RegionTool, stroke: BrushStroke) => void
}
type ActiveStroke = { pointer: number; mode: RegionTool; points: ImagePoint[]; diameter: number; spacing: number }

function appendSample(stroke: ActiveStroke, point: ImagePoint, final: boolean) {
  const last = stroke.points[stroke.points.length - 1]
  const distance = Math.hypot(point[0] - last[0], point[1] - last[1])
  if (!distance || (!final && distance < stroke.spacing)) return
  // Keep both ends of a long gesture while bounding the geometry in each save.
  if (stroke.points.length === maxStrokePoints) {
    stroke.points = stroke.points.filter((_, i) => i % 2 === 0)
    stroke.spacing *= 2
  }
  stroke.points.push(point)
}

export function BrushSurface({ viewer, slide, size, outlineDiameter, region, tool, effectiveTool, atStrokeLimit, onOverride, onDrawing, onStroke }: Props) {
  const active = useRef<ActiveStroke | null>(null)
  const [cursor, setCursor] = useState<ImagePoint | null>(null)
  const [preview, setPreview] = useState<BrushStroke | null>(null)
  const ink = useMemo(() => (preview && addStroke(region, effectiveTool, preview)) || region, [preview, region, effectiveTool])
  const lastStroke = useMemo(() => compoundGeometry(ink).strokes.at(-1), [ink])
  const endpoint = effectiveTool === 'outline' && lastStroke?.mode === 'outline' ? lastStroke.points.at(-1) : null
  const bounds = viewer.viewport.viewportToImageRectangle(viewer.viewport.getBounds(true))
  const imageZoom = viewer.viewport.viewportToImageZoom(viewer.viewport.getZoom(true))
  const brushDiameter = Math.min(size / imageZoom, 2 * Math.max(slide.width, slide.height))
  const diameterFor = (mode: RegionTool) => mode === 'outline' ? outlineDiameter ?? brushDiameter : brushDiameter
  const canStart = (mode: RegionTool) => (mode !== 'erase' || !!region) && (!atStrokeLimit || (mode === 'outline' && outlineDiameter !== null))

  function imagePoint(event: PointerEvent<SVGSVGElement>): ImagePoint {
    const rect = event.currentTarget.getBoundingClientRect()
    const p = viewer.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(event.clientX - rect.left, event.clientY - rect.top))
    return [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]
  }

  const cancel = useCallback(() => {
    active.current = null
    setPreview(null)
    onDrawing(null)
    setCursor(null)
  }, [onDrawing])
  useEffect(() => {
    window.addEventListener('blur', cancel)
    return () => { window.removeEventListener('blur', cancel); onDrawing(null) }
  }, [cancel, onDrawing])

  function start(event: PointerEvent<SVGSVGElement>) {
    if (!event.isPrimary || event.button !== 0 || active.current) return
    const override = brushOverride(event)
    onOverride(override)
    // Latch the mode and width at pointer-down so preview, save and undo agree.
    const mode = override ?? tool
    if (!canStart(mode)) return
    const point = imagePoint(event)
    if (point[0] < 0 || point[1] < 0 || point[0] > slide.width || point[1] > slide.height) return
    event.currentTarget.focus({ preventScroll: true })
    onDrawing(mode)
    event.currentTarget.setPointerCapture(event.pointerId)
    const diameter = diameterFor(mode)
    active.current = { pointer: event.pointerId, mode, points: [point], diameter, spacing: 1.25 / imageZoom }
    setCursor(point)
    setPreview({ shape: 'brush', points: [point], diameter })
  }

  function sample(event: PointerEvent<SVGSVGElement>, final: boolean) {
    if (!event.isPrimary) return
    onOverride(brushOverride(event))
    const point = imagePoint(event)
    const stroke = active.current
    if (!stroke) { setCursor(point); return }
    if (event.pointerId !== stroke.pointer) return
    const bounded: ImagePoint = [Math.max(0, Math.min(point[0], slide.width)), Math.max(0, Math.min(point[1], slide.height))]
    // End on leaving the slide image, so an excursion outside cannot join two marks.
    const end = final || bounded[0] !== point[0] || bounded[1] !== point[1]
    appendSample(stroke, bounded, end)
    if (end) {
      cancel()
      onStroke(stroke.mode, { shape: 'brush', points: stroke.points, diameter: stroke.diameter })
    } else {
      setCursor(point)
      setPreview({ shape: 'brush', points: stroke.points.slice(), diameter: stroke.diameter })
    }
  }

  return <svg className={`drawing-surface tool-${effectiveTool}`} aria-label="Edit evidence on the slide" tabIndex={-1} aria-disabled={!canStart(effectiveTool)}
    viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} preserveAspectRatio="none"
    onPointerDown={start} onPointerMove={event => sample(event, false)} onPointerUp={event => sample(event, true)}
    onContextMenu={event => { if (event.ctrlKey) event.preventDefault() }}
    onPointerCancel={event => { if (active.current?.pointer === event.pointerId) cancel() }}
    onLostPointerCapture={event => { if (active.current?.pointer === event.pointerId) cancel() }}
    onPointerLeave={() => setCursor(null)}>
    {ink && <RegionInk region={ink} bounds={{
      x: Math.max(0, bounds.x), y: Math.max(0, bounds.y),
      width: Math.max(0, Math.min(slide.width, bounds.x + bounds.width) - Math.max(0, bounds.x)),
      height: Math.max(0, Math.min(slide.height, bounds.y + bounds.height) - Math.max(0, bounds.y)),
    }} />}
    {endpoint && cursor && !preview && <line className="outline-guide" x1={endpoint[0]} y1={endpoint[1]} x2={cursor[0]} y2={cursor[1]} />}
    {cursor && canStart(effectiveTool) && <circle className="brush-cursor" cx={cursor[0]} cy={cursor[1]} r={(active.current?.diameter ?? diameterFor(effectiveTool)) / 2} />}
  </svg>
}
