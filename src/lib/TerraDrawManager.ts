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
 * マウス移動ごとに measurePolygon が走るのを抑制する。
 */
class ThrottledMeasureControl extends MaplibreMeasureControl {
  constructor(options?: MeasureControlOptions) {
    super(options)
    const orig = (this as any).handleTerradrawFeatureChanged.bind(this)
    let rafId: number | null = null
    let pendingIds: string[] = []
    let pendingType = 'update'
    ;(this as any).handleTerradrawFeatureChanged = (ids: string[], type: string) => {
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

  // RAF バッチ用ステート
  private _rafId: number | null = null
  private _pendingIds: string[] = []
  private _pendingHasDelete = false
  // ポリゴン図形が1つ以上存在するかのキャッシュ
  private _hasPolygonFeatures = false

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
   * IDs を蓄積してフレームごとに1回だけ処理する。
   * getSnapshotFeature の呼び出しはここではなく RAF 内で行う。
   */
  private _scheduleUpdate(ids: string[], isDelete: boolean): void {
    if (isDelete) {
      this._pendingHasDelete = true
    } else {
      this._pendingIds.push(...ids)
    }
    if (this._rafId !== null) return
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null
      const ids = [...new Set(this._pendingIds)]
      this._pendingIds = []
      const hasDelete = this._pendingHasDelete
      this._pendingHasDelete = false

      if (hasDelete) {
        this._updatePolygonEdges()
        return
      }

      // RAF 内で polygon フィーチャーか判定（同期ホットパスから除外）
      const td = this.control?.getTerraDrawInstance()
      const hasPolygon = !!td && ids.some((id) => {
        const f = (td as any).getSnapshotFeature?.(id)
        return f?.properties?.mode === 'polygon'
      })

      if (hasPolygon) {
        this._updatePolygonEdges()
      } else if (this._hasPolygonFeatures) {
        // ポリゴン図形が存在する場合のみレイヤー順を維持
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
        circle: new TerraDrawCircleMode({ segments: 32 }),
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
    // 同期ハンドラでは ID を蓄積するだけ。重い処理は RAF 内で行う
    td.on('change', (ids: (string | number)[], type: string) => {
      if (type === 'styling') return
      this._scheduleUpdate(ids.map(String), type === 'delete')
    })
    td.on('finish', (id: string | number) => {
      this._scheduleUpdate([String(id)], false)
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
    this._hasPolygonFeatures = features.length > 0
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
