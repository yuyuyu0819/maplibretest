<template>
  <MapView />
</template>

<script setup lang="ts">
import MapView from './components/MapView.vue'
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }

html, body, #app {
  height: 100%;
  font-family: 'Segoe UI', sans-serif;
}

.maplibregl-ctrl button:disabled {
  cursor: not-allowed;
}

.td-draw-locked .maplibregl-terradraw-measure-add-polygon-button,
.td-draw-locked .maplibregl-terradraw-measure-add-rectangle-button,
.td-draw-locked .maplibregl-terradraw-measure-add-circle-button {
  opacity: 0.35 !important;
  cursor: not-allowed !important;
}
</style>
