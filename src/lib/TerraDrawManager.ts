import maplibregl from 'maplibre-gl'
import { MaplibreMeasureControl } from '@watergis/maplibre-gl-terradraw'
import type { MeasureControlOptions, TerradrawMode, TerradrawModeClass } from '@watergis/maplibre-gl-terradraw'
import { TerraDrawCircleMode } from 'terra-draw'
import { ScreenAlignedRectangleMode } from '../modes/ScreenAlignedRectangleMode'
import { ScreenAlignedSelectMode } from '../modes/ScreenAlignedSelectMode'
import { ArcRectangleMode } from '../modes/ArcRectangleMode'

const POLYGON_EDGE_SOURCE = 'polygon-edge-source'
const POLYGON_EDGE_LAYER = 'polygon-edge-labels'

export const MODE_LABELS: Record<string, string> = {
  render: 'なし',
  point: '点（Point）',
  linestring: '線（LineString）',
  polygon: 'ポリゴン（Polygon）',
  rectangle: '矩形（Rectangle）',
  'angled-rectangle': '傾き矩形',
  circle: '円',
  'arc-rectangle': '円弧矩形',
  freehand: 'フリーハンド（面）',
  'freehand-linestring': 'フリーハンド（線）',
  select: '選択・編集',
}

// 'arc-rectangle' は AvailableModes に含まれないため as unknown でキャスト
const MODES = [
  'point',
  'linestring',
  'polygon',
  'rectangle',
  'angled-rectangle',
  'circle',
  'arc-rectangle',
  'freehand',
  'freehand-linestring',
  'select',
  'delete-selection',
  'delete',
  'undo',
  'redo',
  'download',
] as unknown as TerradrawMode[]

/**
 * MaplibreMeasureControl のサブクラス。
 * handleTerradrawFeatureChanged を RAF でバッチ化し、
 * マウス移動のたびに measurePolygon が走るのを抑制する。
 */
class ThrottledMeasureControl extends MaplibreMeasureControl {
  constructor(options?: MeasureControlOptions) {
    super(options)
    const orig = (this as any).handleTerradrawFeatureChanged.bind(this)
    let rafId: number | null = null
    let pendingIds: string[] = []
    let pendingType = 'update'
    ;(this as any).handleTerradrawFeatureChanged = (ids: string[], type: string) => {
      // delete は即時処理してラベルを確実に消す
      if (type === 'delete') { orig(ids, type); return }
      pendingIds.push(...ids)
      pendingType = type
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        const uniqueIds = [...new Set(pendingIds)]
        pendingIds = []
        orig(uniqueIds, pendingType)
      })
    }
  }
}

export class TerraDrawManager {
  private control: ThrottledMeasureControl | null = null
  private map: maplibregl.Map | null = null
  private readonly onModeChanged: (mode: string) => void
  private _rafId: number | null = null
  private _pendingEdgeDataUpdate = false

  constructor(onModeChanged: (mode: string) => void) {
    this.onModeChanged = onModeChanged
  }

  init(map: maplibregl.Map): void {
    this.map = map
    this.control = this._buildControl()
    map.addControl(this.control, 'top-left')
    map.on('load', () => this._setupEdgeLayer())
    this.control.on('mode-changed', (e: { mode: string }) => {
      this.onModeChanged(e.mode in MODE_LABELS ? e.mode : 'render')
    })
  }

  setMode(mode: string): void {
    const td = this.control?.getTerraDrawInstance()
    if (!td) return
    td.setMode(mode === 'render' ? 'render' : mode)
  }

  destroy(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
    this.control = null
    this.map = null
  }

  /**
   * フレームごとに1回だけ処理をまとめる。
   * updateEdgeData=true のとき setData も実行、false のときは moveLayer だけ。
   */
  private _scheduleFrame(updateEdgeData: boolean): void {
    if (updateEdgeData) this._pendingEdgeDataUpdate = true
    if (this._rafId !== null) return
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null
      if (this._pendingEdgeDataUpdate) {
        this._pendingEdgeDataUpdate = false
        this._updatePolygonEdges() // setData + moveLayer
      } else {
        // 矩形・円など非ポリゴン変化時もレイヤー順を維持
        const map = this.map
        if (map?.getLayer(POLYGON_EDGE_LAYER)) map.moveLayer(POLYGON_EDGE_LAYER)
      }
    })
  }

  private _buildControl(): ThrottledMeasureControl {
    return new ThrottledMeasureControl({
      modes: [...MODES],
      open: true,
      modeOptions: {
        rectangle: new ScreenAlignedRectangleMode(),
        circle: new TerraDrawCircleMode(),
        'arc-rectangle': new ArcRectangleMode() as unknown as TerradrawModeClass,
        select: new ScreenAlignedSelectMode({
          flags: {
            circle: {
              feature: {
                draggable: true,
                rotateable: true,
                coordinates: { resizable: 'center', deletable: false, midpoints: false },
              },
            },
            'arc-rectangle': {
              feature: { draggable: true, rotateable: true, scaleable: true },
            },
            rectangle: {
              feature: {
                draggable: true,
                rotateable: true,
                coordinates: { draggable: true, deletable: false, midpoints: false },
              },
            },
          },
        }),
      },
      // polygon モードの面積ラベルを非表示（辺の長さラベルで代替）
      polygonLayerSpec: {
        id: '{prefix}-polygon-label',
        type: 'symbol',
        source: '{prefix}-polygon-source',
        filter: ['all', ['==', '$type', 'Point'], ['!=', 'mode', 'polygon']] as any,
        layout: {
          'text-field': ['concat', ['to-string', ['get', 'area']], ' ', ['get', 'unit']],
          'symbol-placement': 'point',
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 10, 12, 13, 14, 14, 16, 18, 18],
          'text-overlap': 'always',
          'text-letter-spacing': 0.05,
        },
        paint: {
          'text-halo-color': '#F7F7F7',
          'text-halo-width': 2,
          'text-color': '#232E3D',
        },
      },
      measureUnitType: 'metric',
    })
  }

  private _setupEdgeLayer(): void {
    const map = this.map
    if (!map) return
    map.addSource(POLYGON_EDGE_SOURCE, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    })
    map.addLayer({
      id: POLYGON_EDGE_LAYER,
      type: 'symbol',
      source: POLYGON_EDGE_SOURCE,
      layout: {
        'text-field': ['get', 'label'],
        'symbol-placement': 'point',
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 10, 12, 13, 14, 14, 16, 18, 18],
        'text-overlap': 'always',
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.5,
        'text-justify': 'center',
        'text-letter-spacing': 0.05,
      },
      paint: {
        'text-halo-color': '#F7F7F7',
        'text-halo-width': 2,
        'text-color': '#232E3D',
      },
    })
    map.moveLayer(POLYGON_EDGE_LAYER)

    const td = this.control?.getTerraDrawInstance()
    if (!td) return
    td.on('change', (ids: string[], type: string) => {
      if (type === 'styling') return
      const hasPolygon = type === 'delete' || ids.some((id) => {
        const f = (td as any).getSnapshotFeature?.(id)
        return f?.properties?.mode === 'polygon'
      })
      this._scheduleFrame(hasPolygon)
    })
    td.on('finish', (id: string) => {
      const f = (td as any).getSnapshotFeature?.(id)
      this._scheduleFrame(!f || f.properties?.mode === 'polygon')
    })
  }

  private _updatePolygonEdges(): void {
    const map = this.map
    const control = this.control
    if (!map || !control) return
    const source = map.getSource(POLYGON_EDGE_SOURCE) as maplibregl.GeoJSONSource | undefined
    if (!source) return
    const td = control.getTerraDrawInstance()
    if (!td) return
    const features: GeoJSON.Feature[] = []
    for (const f of td.getSnapshot() as any[]) {
      if (f.properties.mode === 'polygon' && f.geometry.type === 'Polygon') {
        features.push(...this._buildEdgeFeatures(
          f.geometry.coordinates[0],
          !!f.properties.currentlyDrawing,
        ))
      }
    }
    source.setData({ type: 'FeatureCollection', features })
    if (map.getLayer(POLYGON_EDGE_LAYER)) map.moveLayer(POLYGON_EDGE_LAYER)
  }

  private _buildEdgeFeatures(ring: [number, number][], skipLast = false): GeoJSON.Feature[] {
    const n = ring.length - 1
    const limit = skipLast ? n - 1 : n
    const features: GeoJSON.Feature[] = []
    for (let i = 0; i < limit; i++) {
      const [lng1, lat1] = ring[i]
      const [lng2, lat2] = ring[(i + 1) % n]
      const dist = this._haversineM(lng1, lat1, lng2, lat2)
      if (dist < 0.01) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [(lng1 + lng2) / 2, (lat1 + lat2) / 2] },
        properties: { label: this._formatDist(dist) },
      })
    }
    return features
  }

  private _haversineM(lng1: number, lat1: number, lng2: number, lat2: number): number {
    const R = 6371000
    const phi1 = (lat1 * Math.PI) / 180
    const phi2 = (lat2 * Math.PI) / 180
    const dphi = ((lat2 - lat1) * Math.PI) / 180
    const dlam = ((lng2 - lng1) * Math.PI) / 180
    const a =
      Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  private _formatDist(m: number): string {
    return m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`
  }
}
