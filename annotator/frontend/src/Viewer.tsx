import { useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { api, type RegionTool, type Region, type SlideInfo } from './types'
import { BrushSurface } from './BrushSurface'
import { brushOverride, regionBounds, regionContains } from './brush'
import { RegionOverlay } from './RegionGraphic'
import type { RegionEditor } from './useRegionEditor'
import { scaleBar, type ScaleBar } from './scale'

type Props = {
  slideId: string; regions: Region[]; focus: Region | null
  editor: RegionEditor; enabled: boolean; onViewed: () => void
}

const ZOOM_STEP = 3

export function Viewer({ slideId, regions, focus, editor, enabled, onViewed }: Props) {
  const element = useRef<HTMLDivElement>(null)
  const viewer = useRef<OpenSeadragon.Viewer | null>(null)
  const [info, setInfo] = useState<SlideInfo | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [brushSize, setBrushSize] = useState(18)
  const { selected, selectedIndex, tool } = editor
  const editing = enabled && ready && !!tool
  const [heldTool, setHeldTool] = useState<ReturnType<typeof brushOverride>>(null)
  const [strokeTool, setStrokeTool] = useState<RegionTool | null>(null)
  const effectiveTool = strokeTool ?? heldTool ?? tool
  const canToggleBrush = enabled && ready && (editing || editor.canDraw)
  const [overlays, setOverlays] = useState(true)
  const [zoom, setZoom] = useState(0)
  const [scale, setScale] = useState<ScaleBar | null>(null)
  const outlineWidth = effectiveTool === 'outline' ? editor.outlineDiameter : null
  const shownWidth = outlineWidth === null ? brushSize : Math.round(outlineWidth * zoom / 100)
  const viewedCallback = useRef(onViewed); viewedCallback.current = onViewed

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let notified = false
    let metadata: SlideInfo | null = null
    setReady(false); setInfo(null); setError(''); setScale(null); setZoom(0)
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
    return () => { active = false; controller.abort(); instance.destroy(); viewer.current = null }
  }, [slideId, attempt])

  useEffect(() => {
    const instance = viewer.current
    if (!instance || !ready || !info || !instance.world.getItemCount()) return
    if (editing || !enabled || !overlays) return
    const pick = (event: OpenSeadragon.CanvasClickEvent) => {
      if (!event.quick) return
      const point = instance.viewport.viewerElementToImageCoordinates(event.position)
      if (point.x < 0 || point.y < 0 || point.x > info.width || point.y > info.height) { editor.select(null); return }
      let id: string | null = null
      for (let i = regions.length - 1; i >= 0; i--) {
        if (regionContains(regions[i], [point.x, point.y])) { id = regions[i].id; break }
      }
      editor.select(id)
    }
    instance.addHandler('canvas-click', pick)
    return () => { instance.removeHandler('canvas-click', pick) }
  }, [regions, ready, overlays, info, editing, enabled, editor.select])

  useEffect(() => {
    const instance = viewer.current
    if (!instance || !focus || !ready || !info) return
    const bounds = regionBounds(focus, info)
    setOverlays(true)
    instance.viewport.fitBoundsWithConstraints(instance.viewport.imageToViewportRectangle(
      bounds.x - bounds.width * 0.15, bounds.y - bounds.height * 0.15, bounds.width * 1.3, bounds.height * 1.3), false)
  }, [focus, ready, info])

  useEffect(() => {
    if (!editing) return
    const clear = () => setHeldTool(null)
    const modifiers = (event: KeyboardEvent) => {
      if (event.key !== 'Control' && event.key !== 'Alt') return
      setHeldTool(brushOverride(event))
      if (event.key === 'Alt' && document.querySelector('.drawing-surface:hover, .drawing-surface:focus')) event.preventDefault()
    }
    window.addEventListener('keydown', modifiers)
    window.addEventListener('keyup', modifiers)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', modifiers)
      window.removeEventListener('keyup', modifiers)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [editing])

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!enabled || !ready || event.defaultPrevented || event.isComposing || event.repeat || event.altKey) return
      const target = event.target
      if (document.querySelector('[aria-modal="true"], .dropdown[open]') ||
          (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))) return
      if (event.key === 'Escape' && editing) { editor.setTool(null); return }
      if (strokeTool) return
      if (event.key === 'Enter' && editing && !event.metaKey && !(target instanceof Element && target.closest('button, summary, a'))) {
        event.preventDefault()
        editor.finish(event.ctrlKey || event.shiftKey)
        return
      }
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'z' && !event.shiftKey && editor.canUndo) { event.preventDefault(); editor.undo() }
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
        event.preventDefault()
        editor.remove(selected.id)
      }
      if (event.key.toLowerCase() === 'r' && canToggleBrush) editor.setTool(editing ? null : 'paint')
      if (event.key.toLowerCase() === 'h') viewer.current?.viewport.goHome()
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [enabled, ready, editor, editing, selected, canToggleBrush, strokeTool])

  return <section className="viewer-pane" aria-label="Whole-slide viewer">
    <div className="viewer-toolbar">
      <div className="tool-group"><button disabled={!ready} title={`Zoom in ×${ZOOM_STEP}`} aria-label="Zoom in" onClick={() => { viewer.current?.viewport.zoomBy(ZOOM_STEP); viewer.current?.viewport.applyConstraints() }}>＋</button><button disabled={!ready} title={`Zoom out ×${ZOOM_STEP}`} aria-label="Zoom out" onClick={() => { viewer.current?.viewport.zoomBy(1 / ZOOM_STEP); viewer.current?.viewport.applyConstraints() }}>−</button><button onClick={() => viewer.current?.viewport.goHome()} title="Fit slide (H)">Fit slide</button></div>
      <div className="tool-group">
        <button disabled={!canToggleBrush} className={editing ? 'selected' : ''} aria-pressed={editing}
          onClick={() => editor.setTool(editing ? null : 'paint')} title="Switch between drawing and navigation (R)">{editing ? 'Pan' : selected ? 'Edit region' : 'Brush'}</button>
        <button disabled={editing} aria-pressed={editing || overlays} onClick={() => { if (overlays) editor.select(null); setOverlays(!overlays) }}>{editing || overlays ? 'Hide' : 'Show'} regions</button>
      </div>
    </div>
    {(editing || selected || editor.canUndo) && enabled && ready && <div className="brush-tools" aria-label="Region tools">
      <strong aria-live="polite">{selected ? `${editing ? 'Editing' : 'Selected'} E${selectedIndex + 1}` : editing ? 'New region' : 'Regions'}</strong>
      {editing && <>
        <div className="tool-group" role="group" aria-label="Drawing tool">{(['paint', 'erase', 'outline'] as RegionTool[]).map(mode =>
          <button key={mode} className={effectiveTool === mode ? 'selected' : ''} aria-pressed={effectiveTool === mode} disabled={mode === 'erase' && !selected}
            onClick={() => editor.setTool(mode)}>{{ paint: 'Paint', erase: 'Erase', outline: 'Outline' }[mode]}</button>)}</div>
        <label title={outlineWidth === null ? undefined : "A connected outline keeps the width of its first point"}>Width <input aria-label="Brush width" disabled={outlineWidth !== null} type="range" min={2} max={80} value={shownWidth} onChange={e => setBrushSize(Number(e.target.value))} /> <output>{shownWidth} px</output></label>
      </>}
      <div className="tool-group">
        <button disabled={!editor.canUndo} onClick={editor.undo} title="Undo last region edit (Ctrl/⌘+Z)">Undo</button>
        <button disabled={!selected} onClick={() => selected && editor.remove(selected.id)} title="Delete selected region (Delete or Backspace)">Delete</button>
      </div>
      {editing && <>
        <div className="tool-group">
          <button disabled={!selected} onClick={() => editor.finish(false)} title="Keep the marks as drawn and start another region (Enter)">Finish &amp; next</button>
          <button disabled={!editor.canFill} onClick={() => editor.finish(true)} title="Join the ends of the last outline or brush stroke and fill it (Ctrl+Enter or Shift+Enter)">Close, fill &amp; next</button>
        </div>
        <span className="region-hint">{editor.atStrokeLimit && outlineWidth === null ? 'Stroke limit reached. Undo a stroke or finish this region.' :
          <>Ctrl + drag to paint · Alt + drag to erase{tool === 'outline' && ' · Click points to trace an outline'}</>}</span>
      </>}
    </div>}
    <div className={editing ? 'viewer-stage brushing' : 'viewer-stage'}>
      <div ref={element} className="osd-viewer" />
      {(overlays || editing) && ready && info && viewer.current && regions.map((region, i) =>
        editing && selected?.id === region.id ? null :
          <RegionOverlay key={region.id} viewer={viewer.current!} region={region} number={i + 1} selected={selected?.id === region.id} slide={info} />)}
      {!ready && !error && <div className="viewer-message"><span className="spinner" /> Opening slide…</div>}
      {error && <div className="viewer-error" role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry opening</button></div>}
      {editing && tool && effectiveTool && info && viewer.current && <BrushSurface key={`${tool}/${selected?.id ?? ''}`} viewer={viewer.current} slide={info} size={brushSize} outlineDiameter={editor.outlineDiameter}
        region={selected} tool={tool} effectiveTool={effectiveTool} atStrokeLimit={editor.atStrokeLimit}
        onOverride={setHeldTool} onDrawing={setStrokeTool} onStroke={(mode, stroke) => { editor.draw(mode, stroke); setOverlays(true) }} />}
      <div className="viewer-label">H&amp;E <span>WHOLE SLIDE</span></div>
      {ready && scale && <div className="scale-bar" title={scale.calibrated ? `${info?.mpp} µm per pixel · ${info?.calibration_source || 'Slide metadata'}` : 'No physical calibration found in slide metadata'} aria-label={`Scale bar: ${scale.label}${scale.calibrated ? '' : ' in the original image; physical size unavailable'}`}>
        <span>{scale.label}</span><div className="scale-ruler" style={{ width: scale.width }} />
        {!scale.calibrated && <small>Image pixels · physical size unavailable</small>}
      </div>}
    </div>
    <div className="viewer-status"><span>{info ? `${info.width.toLocaleString()} × ${info.height.toLocaleString()} px` : 'Reading slide details…'}{info?.objective && ` · ${info.objective}× objective`}</span><span>{zoom > 0 ? `${zoom.toFixed(1)}% · ` : ''}{editing ? 'Region editing' : 'Scroll to zoom · Drag to move'}</span></div>
  </section>
}
