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
import { MaplibreTerradrawControl } from '@watergis/maplibre-gl-terradraw'
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
let drawControl: MaplibreTerradrawControl | null = null

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

  drawControl = new MaplibreTerradrawControl({
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
  })

  map.addControl(drawControl, 'top-left')

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
