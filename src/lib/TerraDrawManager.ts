import maplibregl from 'maplibre-gl'
import { MaplibreMeasureControl, calcArea } from '@watergis/maplibre-gl-terradraw'
import type { MeasureControlOptions, TerradrawMode } from '@watergis/maplibre-gl-terradraw'
import { TerraDrawCircleMode } from 'terra-draw'
import { ScreenAlignedRectangleMode } from '../modes/ScreenAlignedRectangleMode'
import { ScreenAlignedSelectMode } from '../modes/ScreenAlignedSelectMode'

const AREA_UNIT = (m2: number) =>
  m2 >= 1e6 ? { area: m2 / 1e6, unit: 'km²' } : { area: m2, unit: 'm²' }

const POLYGON_EDGE_SOURCE = 'polygon-edge-source'
const POLYGON_EDGE_LAYER = 'polygon-edge-labels'

export const DRAWING_MODES = new Set(['polygon', 'rectangle', 'circle'])

export const MODE_LABELS: Record<string, string> = {
  render: 'なし',
  polygon: 'ポリゴン（Polygon）',
  rectangle: '矩形（Rectangle）',
  circle: '円',
  select: '選択・編集',
}

const MODES = [
  'polygon',
  'rectangle',
  'circle',
  'select',
  'delete',
] as unknown as TerradrawMode[]

/**
 * MaplibreMeasureControl のサブクラス。
 * handleTerradrawFeatureChanged を RAF でバッチ化し、
 * マウス移動ごとに measurePolygon が走るのを抑制する。
 */
class ThrottledMeasureControl extends MaplibreMeasureControl {
  private _el: HTMLElement | null = null

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

  override onAdd(map: maplibregl.Map): HTMLElement {
    const el = super.onAdd(map)
    this._el = el
    return el
  }

  setVisible(visible: boolean): void {
    if (this._el) this._el.style.display = visible ? '' : 'none'
  }

  setDrawingModesDisabled(disabled: boolean): void {
    if (!this._el) return
    if (disabled) {
      this._el.classList.add('td-draw-locked')
    } else {
      this._el.classList.remove('td-draw-locked')
    }
  }
}

export class TerraDrawManager {
  private control: ThrottledMeasureControl | null = null
  private map: maplibregl.Map | null = null
  private readonly onModeChanged: (mode: string) => void
  private readonly onStateChanged: (hasFeature: boolean) => void
  private readonly onFinish: (feature: GeoJSON.Feature) => void

  // RAF バッチ用ステート
  private _rafId: number | null = null
  private _pendingIds: string[] = []
  private _pendingHasDelete = false
  // ポリゴン図形が1つ以上存在するかのキャッシュ
  private _hasPolygonFeatures = false
  // 完成済みフィーチャーが1つ以上存在するか
  private _hasFeature = false
  // mode-changed で select に戻す際の再帰防止フラグ
  private _isReverting = false

  constructor(
    onModeChanged: (mode: string) => void = () => {},
    onStateChanged: (hasFeature: boolean) => void = () => {},
    onFinish: (feature: GeoJSON.Feature) => void = () => {},
  ) {
    this.onModeChanged = onModeChanged
    this.onStateChanged = onStateChanged
    this.onFinish = onFinish
  }

  init(map: maplibregl.Map): void {
    this.map = map
    this.control = this._buildControl()
    map.addControl(this.control, 'top-left')
    map.on('load', () => this._setupEdgeLayer())
    this.control.on('mode-changed', (e: { mode: string }) => {
      const mode = e.mode
      // 再帰で発火した select への切り替えをそのまま通す
      if (this._isReverting) {
        this._isReverting = false
        this.onModeChanged(mode in MODE_LABELS ? mode : 'render')
        return
      }
      // フィーチャー存在中・描画中は描画モードへの切り替えを阻止して select に戻す
      if (this._shouldBlockDrawingMode() && DRAWING_MODES.has(mode)) {
        this._isReverting = true
        this.control?.getTerraDrawInstance()?.setMode('select')
        return
      }
      this.onModeChanged(mode in MODE_LABELS ? mode : 'render')
    })
  }

  /** 描画モードを設定する。フィーチャー存在中は描画モードへの切り替えを無視する */
  setMode(mode: string): void {
    if (this._shouldBlockDrawingMode() && DRAWING_MODES.has(mode)) return
    const td = this.control?.getTerraDrawInstance()
    if (!td) return
    td.setMode(mode === 'render' ? 'render' : mode)
  }

  /** 描画ツールパネルの表示/非表示を切り替える */
  setVisible(visible: boolean): void {
    this.control?.setVisible(visible)
  }

  /** 現在のフィーチャー（描画中・完成問わず）の面積を返す。Polygon でなければ null */
  getFeatureArea(): { area: number; unit: string } | null {
    const td = this.control?.getTerraDrawInstance()
    if (!td) return null
    const feature = (td.getSnapshot() as GeoJSON.Feature[]).find(
      (f) => f.geometry.type === 'Polygon',
    )
    if (!feature) return null
    const result = calcArea(feature as any, 'metric', 2, AREA_UNIT)
    const props = result.properties as any
    return { area: props.area, unit: props.unit }
  }

  /** 描画済み（確定した）フィーチャーの一覧を返す */
  getFeatures(): GeoJSON.Feature[] {
    const td = this.control?.getTerraDrawInstance()
    if (!td) return []
    return (td.getSnapshot() as GeoJSON.Feature[]).filter(
      (f) => !(f.properties as any)?.currentlyDrawing,
    )
  }

  destroy(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
    }
    this.control = null
    this.map = null
  }

  /** 完成済みフィーチャーが存在するか、または描画中かを返す */
  private _shouldBlockDrawingMode(): boolean {
    if (this._hasFeature) return true
    const td = this.control?.getTerraDrawInstance()
    if (!td) return false
    return (td.getSnapshot() as any[]).some((f) => f.properties?.currentlyDrawing)
  }

  private _setHasFeature(value: boolean): void {
    if (value === this._hasFeature) return
    this._hasFeature = value
    this.onStateChanged(value)
    this.control?.setDrawingModesDisabled(value)
  }

  private _updateHasFeature(): void {
    const td = this.control?.getTerraDrawInstance()
    if (!td) return
    const hasFeature = (td.getSnapshot() as any[]).some(
      (f) => !f.properties?.currentlyDrawing,
    )
    this._setHasFeature(hasFeature)
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
        this._updateHasFeature()
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
        select: new ScreenAlignedSelectMode({
          flags: {
            circle: {
              feature: {
                draggable: true,
                rotateable: true,
                coordinates: { resizable: 'center', deletable: false, midpoints: false },
              },
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
      areaUnit: AREA_UNIT,
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
      // finish と同時に即座にブロック → RAF で mode 切り替えと選択
      this._setHasFeature(true)
      const feature = (td as any).getSnapshotFeature?.(id) as GeoJSON.Feature | undefined
      if (feature) this.onFinish(feature)
      requestAnimationFrame(() => {
        const tdInstance = this.control?.getTerraDrawInstance()
        if (!tdInstance) return
        tdInstance.setMode('select')
        tdInstance.selectFeature(id)
      })
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
