<template>
  <div class="map-wrapper">
    <div ref="mapContainer" class="map" />

    <div class="mode-panel">
      <h3>描画モード</h3>
      <select v-model="selectedMode" @change="drawManager?.setMode(selectedMode)">
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
import '@watergis/maplibre-gl-terradraw/dist/maplibre-gl-terradraw.css'
import { TerraDrawManager, MODE_LABELS } from '../lib/TerraDrawManager'

const mapContainer = ref<HTMLDivElement | null>(null)
const selectedMode = ref<string>('render')
const currentModeLabel = ref<string>('なし')

let map: maplibregl.Map | null = null
let drawManager: TerraDrawManager | null = null

onMounted(() => {
  if (!mapContainer.value) return

  map = new maplibregl.Map({
    container: mapContainer.value,
    style: 'https://demotiles.maplibre.org/style.json',
    center: [139.7, 35.68],
    zoom: 9,
  })

  drawManager = new TerraDrawManager((mode) => {
    selectedMode.value = mode
    currentModeLabel.value = MODE_LABELS[mode] ?? 'なし'
  })
  drawManager.init(map)
})

onUnmounted(() => {
  drawManager?.destroy()
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
