import { memo, useId, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type OpenSeadragon from 'openseadragon'
import { brushPath, compoundGeometry, regionBounds } from './brush'
import type { Bounds, BrushStroke, Compound, Region, RegionStroke, SlideInfo } from './types'

const StrokePath = memo(function StrokePath({ stroke }: { stroke: RegionStroke }) {
  const d = useMemo(() => brushPath(stroke.points) + (stroke.mode === 'fill' ? 'Z' : ''), [stroke])
  return <path d={d} stroke={stroke.mode === 'erase' ? 'black' : 'currentColor'} strokeWidth={stroke.diameter}
    strokeLinecap="round" strokeLinejoin="round" fill={stroke.mode === 'fill' ? 'currentColor' : 'none'} fillRule="evenodd" />
})

export const RegionInk = memo(function RegionInk({ region, bounds }: { region: Bounds | BrushStroke | Compound; bounds: Bounds }) {
  const mask = useId()
  const { base, strokes } = useMemo(() => compoundGeometry(region), [region])
  const marks = <>
    {base && <rect {...base} fill="currentColor" />}
    {strokes.map((stroke, i) => <StrokePath key={i} stroke={stroke} />)}
  </>
  const box = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  if (!strokes.some(stroke => stroke.mode === 'erase')) {
    // Additive marks can stay vector paths even when a large region is magnified.
    return <>
      <defs><clipPath id={mask}><rect {...box} /></clipPath></defs>
      <g color="#4189ed" opacity={0.55} clipPath={`url(#${mask})`}>{marks}</g>
    </>
  }
  return <>
    <defs><mask id={mask} maskUnits="userSpaceOnUse" {...box} color="white">{marks}</mask></defs>
    <rect {...box} fill="#4189ed" fillOpacity={0.55} mask={`url(#${mask})`} />
  </>
})

type OverlayProps = { viewer: OpenSeadragon.Viewer; region: Region; number: number; selected: boolean; slide: SlideInfo }
export const RegionOverlay = memo(function RegionOverlay({ viewer, region, number, selected, slide }: OverlayProps) {
  const [element] = useState(() => document.createElement('div'))
  const bounds = useMemo(() => regionBounds(region, slide), [region, slide])
  const { x, y, width, height } = bounds
  useLayoutEffect(() => {
    viewer.addOverlay({ element, location: viewer.viewport.imageToViewportRectangle(x, y, width, height) })
    return () => { viewer.removeOverlay(element) }
  }, [viewer, element, x, y, width, height])
  useLayoutEffect(() => {
    element.className = ['evidence-overlay', 'shape' in region && 'brush-overlay', selected && 'selected-region'].filter(Boolean).join(' ')
    element.title = region.label || `Evidence ${number}`
  }, [element, region, selected, number])
  return createPortal(<>
    {'shape' in region && <svg viewBox={`${x} ${y} ${width} ${height}`} preserveAspectRatio="none"><RegionInk region={region} bounds={bounds} /></svg>}
    <span>E{number}</span>
  </>, element)
})
