<template>
  <div class="map-wrapper">
    <div ref="mapContainer" class="map" />

    <div class="mode-panel">
      <h3>描画モード</h3>
      <select v-model="selectedMode" @change="changeMode(selectedMode)">
        <option value="render">-- 選択してください --</option>
        <option value="point">点（Point）</option>
        <option value="linestring">線（LineString）</option>
        <option value="polygon">ポリゴン（Polygon）</option>
        <option value="rectangle">矩形（Rectangle）</option>
        <option value="angled-rectangle">傾き矩形</option>
        <option value="circle">円 / 回転楕円</option>
        <option value="arc-rectangle">円弧矩形</option>
        <option value="freehand">フリーハンド（面）</option>
        <option value="freehand-linestring">フリーハンド（線）</option>
        <option value="select">選択・編集</option>
      </select>
      <div class="current-mode">現在: <span>{{ currentModeLabel }}</span></div>
      <div v-if="selectedMode === 'arc-rectangle'" class="mode-hint">
        辺をクリック: 選択（中点マーカー）<br>
        ドラッグ: 円弧の深さ調整<br>
        Enter: 確定 / Esc: キャンセル
      </div>
      <div v-if="selectedMode === 'select'" class="mode-hint">
        クリック: 図形を選択<br>
        ドラッグ: 移動<br>
        Ctrl+R+ドラッグ: 回転<br>
        スケールハンドル: 拡縮
      </div>
      <div v-if="selectedMode === 'circle'" class="mode-hint">
        ①中心クリック<br>
        ②長軸クリック<br>
        ③短軸クリックで確定
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MaplibreMeasureControl } from '@watergis/maplibre-gl-terradraw'
import type { TerradrawMode, TerradrawModeClass } from '@watergis/maplibre-gl-terradraw'
import '@watergis/maplibre-gl-terradraw/dist/maplibre-gl-terradraw.css'
import { ScreenAlignedRectangleMode } from '../modes/ScreenAlignedRectangleMode'
import { ScreenAlignedSelectMode } from '../modes/ScreenAlignedSelectMode'
import { RotatableCircleMode } from '../modes/RotatableCircleMode'
import { ArcRectangleMode } from '../modes/ArcRectangleMode'

const mapContainer = ref<HTMLDivElement | null>(null)
const selectedMode = ref<string>('render')
const currentModeLabel = ref<string>('なし')

let map: maplibregl.Map | null = null
let drawControl: MaplibreMeasureControl | null = null

const POLYGON_EDGE_SOURCE = 'polygon-edge-source'
const POLYGON_EDGE_LAYER = 'polygon-edge-labels'

function haversineM(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371000
  const phi1 = (lat1 * Math.PI) / 180
  const phi2 = (lat2 * Math.PI) / 180
  const dphi = ((lat2 - lat1) * Math.PI) / 180
  const dlam = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`
}

function buildEdgeFeatures(ring: [number, number][]): GeoJSON.Feature[] {
  const n = ring.length - 1 // polygon ring: last == first
  const features: GeoJSON.Feature[] = []
  for (let i = 0; i < n; i++) {
    const [lng1, lat1] = ring[i]
    const [lng2, lat2] = ring[(i + 1) % n]
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(lng1 + lng2) / 2, (lat1 + lat2) / 2] },
      properties: { label: formatDist(haversineM(lng1, lat1, lng2, lat2)) },
    })
  }
  return features
}

function updatePolygonEdges(): void {
  if (!map || !drawControl) return
  const source = map.getSource(POLYGON_EDGE_SOURCE) as maplibregl.GeoJSONSource | undefined
  if (!source) return
  const td = drawControl.getTerraDrawInstance()
  if (!td) return
  const features: GeoJSON.Feature[] = []
  for (const f of td.getSnapshot() as any[]) {
    if (f.properties.mode === 'polygon' && f.geometry.type === 'Polygon') {
      features.push(...buildEdgeFeatures(f.geometry.coordinates[0]))
    }
  }
  source.setData({ type: 'FeatureCollection', features })
}

// 'arc-rectangle' は AvailableModes に含まれないため as unknown as TerradrawMode[] でキャスト
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

const MODE_LABELS: Record<string, string> = {
  render: 'なし',
  point: '点（Point）',
  linestring: '線（LineString）',
  polygon: 'ポリゴン（Polygon）',
  rectangle: '矩形（Rectangle）',
  'angled-rectangle': '傾き矩形',
  circle: '円 / 回転楕円',
  'arc-rectangle': '円弧矩形',
  freehand: 'フリーハンド（面）',
  'freehand-linestring': 'フリーハンド（線）',
  select: '選択・編集',
}

function changeMode(mode: string) {
  const td = drawControl?.getTerraDrawInstance()
  if (!td) return
  td.setMode(mode === 'render' ? 'render' : mode)
  currentModeLabel.value = MODE_LABELS[mode] ?? mode
}

onMounted(() => {
  if (!mapContainer.value) return

  map = new maplibregl.Map({
    container: mapContainer.value,
    style: 'https://demotiles.maplibre.org/style.json',
    center: [139.7, 35.68],
    zoom: 9,
  })

  drawControl = new MaplibreMeasureControl({
    modes: [...MODES],
    open: true,
    modeOptions: {
      rectangle: new ScreenAlignedRectangleMode(),
      circle: new RotatableCircleMode(),
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
    // polygon モードの面積ラベルを非表示（辺の長さで代替）
    polygonLayerSpec: {
      id: '{prefix}-polygon-label',
      type: 'symbol',
      source: '{prefix}-polygon-source',
      filter: ['all', ['==', '$type', 'Point'], ['!=', 'mode', 'polygon']] as any,
      layout: {
        'text-field': ['concat', ['to-string', ['get', 'area']], ' ', ['get', 'unit']],
        'symbol-placement': 'point',
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          5, 10, 10, 12, 13, 14, 14, 16, 18, 18,
        ],
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

  map.addControl(drawControl, 'top-left')

  // ポリゴン辺の長さ表示レイヤーをマップロード後に追加し、terra-draw イベントを購読
  map.on('load', () => {
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
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          5, 10, 10, 12, 13, 14, 14, 16, 18, 18,
        ],
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

    const td = drawControl!.getTerraDrawInstance()
    if (td) {
      td.on('change', (_ids: string[], type: string) => {
        if (type !== 'styling') updatePolygonEdges()
      })
      td.on('finish', () => updatePolygonEdges())
    }
  })

  // プラグイン側のモード変更をセレクトに反映
  drawControl.on('mode-changed', (e: { mode: string }) => {
    if (e.mode in MODE_LABELS) {
      selectedMode.value = e.mode
      currentModeLabel.value = MODE_LABELS[e.mode]
    } else {
      selectedMode.value = 'render'
      currentModeLabel.value = 'なし'
    }
  })
})

onUnmounted(() => {
  map?.remove()
})
</script>

<style scoped>
.map-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
}

.map {
  width: 100%;
  height: 100%;
}

.mode-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 8px;
  padding: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  width: 180px;
  z-index: 10;
}

.mode-panel h3 {
  font-size: 12px;
  color: #555;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.mode-panel select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid #ccc;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
  background: white;
}

.current-mode {
  margin-top: 8px;
  font-size: 12px;
  color: #888;
}

.current-mode span {
  font-weight: bold;
  color: #333;
}

.mode-hint {
  margin-top: 8px;
  font-size: 11px;
  color: #666;
  line-height: 1.6;
  border-top: 1px solid #eee;
  padding-top: 6px;
}
</style>
