import { useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { api, type Region, type SlideInfo } from './types'
import { scaleBar, type ScaleBar } from './scale'

type Props = { slideId: string; regions: Region[]; onRegion: (region: Region) => void; focus: Region | null; enabled: boolean; onViewed: () => void }

const ZOOM_STEP = 3

export function Viewer({ slideId, regions, onRegion, focus, enabled, onViewed }: Props) {
  const element = useRef<HTMLDivElement>(null)
  const viewer = useRef<OpenSeadragon.Viewer | null>(null)
  const [info, setInfo] = useState<SlideInfo | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [drawing, setDrawing] = useState(false)
  const [overlays, setOverlays] = useState(true)
  const [zoom, setZoom] = useState(0)
  const [scale, setScale] = useState<ScaleBar | null>(null)
  const [drag, setDrag] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const overlayElements = useRef<HTMLDivElement[]>([])
  const viewedCallback = useRef(onViewed); viewedCallback.current = onViewed

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let notified = false
    let metadata: SlideInfo | null = null
    setReady(false); setInfo(null); setError(''); setDrawing(false); setScale(null); setZoom(0)
    const instance = OpenSeadragon({
      element: element.current!,
      showNavigationControl: false, showNavigator: true, navigatorPosition: 'BOTTOM_RIGHT',
      navigatorWidth: 150, navigatorHeight: 110, navigatorAutoFade: false,
      animationTime: 0.08, blendTime: 0.08, maxZoomPixelRatio: 2,
      // Request sharp tiles promptly and keep recent zoom levels available.
      // Bound outstanding work so rapid zooming does not swamp a local drive.
      immediateRender: true, maxTilesPerFrame: 3, imageLoaderLimit: 6,
      maxImageCacheCount: 400,
      zoomPerScroll: 2, zoomPerClick: ZOOM_STEP,
      navigatorDisplayRegionColor: '#477dcc', navigatorBorderColor: '#acbde0',
      visibilityRatio: 0.65, constrainDuringPan: true,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
    })
    viewer.current = instance
    function updateScale() {
      if (!active || !metadata || !instance.world.getItemCount()) return
      const imageZoom = instance.viewport.viewportToImageZoom(instance.viewport.getZoom(true))
      setZoom(imageZoom * 100)
      setScale(scaleBar(imageZoom, metadata.mpp, Math.min(120, instance.viewport.getContainerSize().x / 4)))
    }
    instance.addHandler('open', () => { if (active) { setReady(true); updateScale() } })
    instance.addHandler('tile-loaded', () => {
      if (active && !notified) { notified = true; viewedCallback.current() }
    })
    instance.addHandler('open-failed', () => { if (active) setError('This slide could not be opened. Check the drive connection and slide format.') })
    instance.addHandler('tile-load-failed', () => { if (active) setError('Some image tiles could not be read. Reopen the slide or check the drive.') })
    instance.addHandler('animation', updateScale)
    instance.addHandler('resize', updateScale)
    instance.addHandler('animation-finish', updateScale)
    // Get the reader's precise error before starting OpenSeadragon, whose generic
    // open-failed event used to overwrite the useful backend explanation.
    api<SlideInfo>(`/api/slides/${slideId}/info`, { signal: controller.signal }).then(result => {
      if (!active) return
      metadata = result
      setInfo(metadata)
      instance.open({ tileSource: `/api/slides/${slideId}/dzi.dzi` })
    }).catch(e => { if (e.name !== 'AbortError' && active) setError(e.message) })
    return () => { active = false; controller.abort(); instance.destroy(); viewer.current = null; overlayElements.current = [] }
  }, [slideId, attempt])

  useEffect(() => {
    const instance = viewer.current
    if (!instance || !ready) return
    for (const el of overlayElements.current) instance.removeOverlay(el)
    overlayElements.current = []
    if (!overlays) return
    regions.forEach((region, i) => {
      const el = document.createElement('div'); el.className = 'evidence-overlay'
      const label = document.createElement('span'); label.textContent = `E${i + 1}`; el.append(label)
      el.title = region.label || `Evidence ${i + 1}`
      instance.addOverlay({ element: el, location: instance.viewport.imageToViewportRectangle(region.x, region.y, region.width, region.height) })
      overlayElements.current.push(el)
    })
  }, [regions, ready, overlays])

  useEffect(() => {
    if (focus && ready) viewer.current?.viewport.fitBounds(viewer.current.viewport.imageToViewportRectangle(focus.x, focus.y, focus.width, focus.height), false)
  }, [focus, ready])

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, button') || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key.toLowerCase() === 'r' && enabled && ready) setDrawing(d => !d)
      if (event.key === 'Escape') { setDrawing(false); setDrag(null); start.current = null }
      if (event.key.toLowerCase() === 'h') viewer.current?.viewport.goHome()
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [enabled, ready])

  function endDrawing(event: React.PointerEvent<HTMLDivElement>) {
    const initial = start.current; start.current = null; setDrag(null)
    if (!initial || !viewer.current || !info) return
    const rect = event.currentTarget.getBoundingClientRect()
    const end = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    if (Math.abs(end.x - initial.x) < 6 || Math.abs(end.y - initial.y) < 6) return
    const a = viewer.current.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(initial.x, initial.y))
    const b = viewer.current.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(end.x, end.y))
    const x = Math.max(0, Math.min(info.width, Math.min(a.x, b.x)))
    const y = Math.max(0, Math.min(info.height, Math.min(a.y, b.y)))
    const right = Math.max(0, Math.min(info.width, Math.max(a.x, b.x)))
    const bottom = Math.max(0, Math.min(info.height, Math.max(a.y, b.y)))
    if (right - x > 1 && bottom - y > 1) {
      onRegion({ id: crypto.randomUUID(), label: '', x, y, width: right - x, height: bottom - y })
      setDrawing(false); setOverlays(true)
    }
  }

  return <section className="viewer-pane" aria-label="Whole-slide viewer">
    <div className="viewer-toolbar">
      <div className="tool-group"><button disabled={!ready} title={`Zoom in ×${ZOOM_STEP}`} aria-label="Zoom in" onClick={() => { viewer.current?.viewport.zoomBy(ZOOM_STEP); viewer.current?.viewport.applyConstraints() }}>＋</button><button disabled={!ready} title={`Zoom out ×${ZOOM_STEP}`} aria-label="Zoom out" onClick={() => { viewer.current?.viewport.zoomBy(1 / ZOOM_STEP); viewer.current?.viewport.applyConstraints() }}>−</button><button onClick={() => viewer.current?.viewport.goHome()} title="Fit slide (H)">Fit slide</button></div>
      <div className="tool-group"><button disabled={!ready || !enabled} className={drawing ? 'selected' : ''} aria-pressed={drawing} onClick={() => setDrawing(d => !d)} title="Mark a region with a rectangle (R)">▧ Mark region</button><button aria-pressed={overlays} onClick={() => setOverlays(v => !v)}>{overlays ? 'Hide' : 'Show'} regions</button></div>
    </div>
    <div className="viewer-stage">
      <div ref={element} className="osd-viewer" />
      {!ready && !error && <div className="viewer-message"><span className="spinner" /> Opening slide…</div>}
      {error && <div className="viewer-error" role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry opening</button></div>}
      {drawing && <div className="drawing-surface" aria-label="Draw evidence rectangle" onPointerDown={event => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const rect = event.currentTarget.getBoundingClientRect()
        start.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }} onPointerMove={event => {
        if (!start.current) return
        const rect = event.currentTarget.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top
        setDrag({ x: Math.min(x, start.current.x), y: Math.min(y, start.current.y), width: Math.abs(x - start.current.x), height: Math.abs(y - start.current.y) })
      }} onPointerUp={endDrawing} onPointerCancel={() => { start.current = null; setDrag(null) }}>
        {drag && <div className="draft-rectangle" style={{ left: drag.x, top: drag.y, width: drag.width, height: drag.height }} />}
        <div className="draw-hint">Drag to mark a region · Esc to cancel</div>
      </div>}
      <div className="viewer-label">H&amp;E <span>WHOLE SLIDE</span></div>
      {ready && scale && <div className="scale-bar" title={scale.calibrated ? `${info?.mpp} µm per pixel · ${info?.calibration_source || 'Slide metadata'}` : 'No physical calibration found in slide metadata'} aria-label={`Scale bar: ${scale.label}${scale.calibrated ? '' : ' in the original image; physical size unavailable'}`}>
        <span>{scale.label}</span><div className="scale-ruler" style={{ width: scale.width }} />
        {!scale.calibrated && <small>Image pixels · physical size unavailable</small>}
      </div>}
    </div>
    <div className="viewer-status"><span>{info ? `${info.width.toLocaleString()} × ${info.height.toLocaleString()} px` : 'Reading slide details…'}{info?.objective && ` · ${info.objective}× objective`}</span><span>{zoom > 0 ? `${zoom.toFixed(1)}% · ` : ''}Scroll to zoom · Drag to move</span></div>
  </section>
}
