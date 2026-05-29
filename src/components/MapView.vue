<template>
  <div class="map-wrapper">
    <div ref="mapContainer" class="map" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@watergis/maplibre-gl-terradraw/dist/maplibre-gl-terradraw.css'
import { TerraDrawManager } from '../lib/TerraDrawManager'

const mapContainer = ref<HTMLDivElement | null>(null)

let map: maplibregl.Map | null = null
const drawManager = ref<TerraDrawManager | null>(null)

function getFeatures(): GeoJSON.Feature[] {
  return drawManager.value?.getFeatures() ?? []
}

function setVisible(visible: boolean): void {
  drawManager.value?.setVisible(visible)
}

defineExpose({ getFeatures, setVisible })

onMounted(() => {
  if (!mapContainer.value) return

  map = new maplibregl.Map({
    container: mapContainer.value,
    style: 'https://demotiles.maplibre.org/style.json',
    center: [139.7, 35.68],
    zoom: 9,
  })

    drawManager.value = new TerraDrawManager(
    () => {},
    () => {},
    (feature) => {
       console.log(feature)
    }
  )

  drawManager.value.init(map)
})

onUnmounted(() => {
  drawManager.value?.destroy()
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
</style>
