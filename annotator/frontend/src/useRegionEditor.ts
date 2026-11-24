import { useMemo, useState } from 'react'
import { addStroke, closeOutline, compoundGeometry, maxRegionStrokes } from './brush'
import { maxEvidenceRegions, type BrushStroke, type Compound, type Region, type RegionTool } from './types'

type UndoEntry = { id: string; before: Region | null; index: number }
export type RegionEditor = ReturnType<typeof useRegionEditor>

export function useRegionEditor(regions: Region[], change: (regions: Region[]) => void) {
  const [selectedId, select] = useState<string | null>(null)
  const [tool, setTool] = useState<RegionTool | null>(null)
  const [history, setHistory] = useState<UndoEntry[]>([])
  const selectedIndex = regions.findIndex(region => region.id === selectedId)
  const selected = regions[selectedIndex] ?? null
  const closed = useMemo(() => closeOutline(selected), [selected])
  const strokes = selected ? compoundGeometry(selected).strokes : []
  const last = strokes.at(-1)
  const outlineDiameter = last?.mode === 'outline' ? last.diameter : null
  const atStrokeLimit = strokes.length >= maxRegionStrokes
  const canDraw = !!selected || regions.length < maxEvidenceRegions

  function remember(id: string, index: number) {
    setHistory(previous => [...previous.slice(-49), { id, index, before: regions[index] ?? null }])
  }

  function saveGeometry(geometry: Compound) {
    const id = selected?.id ?? crypto.randomUUID()
    remember(id, selectedIndex)
    const region = { ...geometry, id, label: selected?.label ?? '' }
    change(selected ? regions.map(r => r.id === id ? region : r) : [...regions, region])
    select(id)
  }

  function draw(mode: RegionTool, stroke: BrushStroke) {
    if (!tool || !canDraw) return
    const geometry = addStroke(selected, mode, stroke)
    if (geometry) saveGeometry(geometry)
  }

  function finish(fill: boolean) {
    if (!selected || !tool || (fill && !closed)) return
    if (fill && closed) saveGeometry(closed)
    select(null)
    if (regions.length >= maxEvidenceRegions) setTool(null)
    else if (tool === 'erase') setTool('paint')
  }

  function remove(id: string) {
    const index = regions.findIndex(r => r.id === id)
    if (index < 0) return
    remember(id, index)
    change(regions.filter(region => region.id !== id))
    if (selectedId === id) {
      select(null)
      if (tool === 'erase') setTool('paint')
    }
  }

  function undo() {
    const entry = history.at(-1)
    if (!entry) return
    const next = [...regions]
    const index = next.findIndex(region => region.id === entry.id)
    if (!entry.before && index >= 0) next.splice(index, 1)
    if (entry.before && index < 0) next.splice(entry.index, 0, entry.before)
    if (entry.before && index >= 0) next[index] = { ...entry.before, label: next[index].label }
    change(next)
    setHistory(previous => previous.slice(0, -1))
    select(entry.before?.id ?? null)
    if (!entry.before && tool === 'erase') setTool('paint')
  }

  function reset() {
    select(null)
    setTool(null)
    setHistory([])
  }

  return { selected, selectedIndex, select, tool, setTool, canDraw, outlineDiameter, atStrokeLimit, canFill: !!closed,
    canUndo: history.length > 0, draw, finish, remove, undo, reset }
}
