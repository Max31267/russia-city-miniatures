import * as maplibregl from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Feature as GeoFeature, FeatureCollection, Polygon } from 'geojson';
import { loadFeatures } from './data';
import { boundsFromCenter, dimensionsM, validBounds } from './geo';
import type { Bounds, BuildRequest, BuildResult, Feature, ModelSettings, Point } from './types';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error('Отсутствует элемент ' + id);
  return found as T;
}

const city = element<HTMLSelectElement>('city');
const drawButton = element<HTMLButtonElement>('draw');
const centerButton = element<HTMLButtonElement>('center');
const sizeInput = element<HTMLInputElement>('size');
const terrainInput = element<HTMLInputElement>('terrain-scale');
const labelInput = element<HTMLInputElement>('label');
const sizeValue = element<HTMLOutputElement>('size-value');
const terrainValue = element<HTMLOutputElement>('terrain-value');
const areaInfo = element<HTMLParagraphElement>('area-info');
const coordinates = element<HTMLSpanElement>('map-coordinates');
const generateButton = element<HTMLButtonElement>('generate');
const downloadButton = element<HTMLButtonElement>('download');
const status = element<HTMLParagraphElement>('status');
const stats = element<HTMLParagraphElement>('stats');
const editor = element<HTMLDivElement>('building-editor');
const buildingId = element<HTMLSpanElement>('building-id');
const buildingHeight = element<HTMLInputElement>('building-height');
const applyHeight = element<HTMLButtonElement>('apply-height');
const preview = element<HTMLDivElement>('preview');
const previewEmpty = element<HTMLDivElement>('preview-empty');

let selectedBounds: Bounds = boundsFromCenter([37.6176, 55.7558], 400, 400);
let cachedFeatures: Feature[] | null = null;
let cachedBounds = '';
let selectedBuilding: Feature | null = null;
let resultStl: ArrayBuffer | null = null;
let busy = false;
let drawing = false;
let drawStart: Point | null = null;
let activeWorker: Worker | null = null;
const heightOverrides: Record<string, number> = {};

function message(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function boundsKey(bounds: Bounds): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north].map(v => v.toFixed(7)).join(',');
}

function boxGeoJson(bounds: Bounds): GeoFeature<Polygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [bounds.west, bounds.south], [bounds.east, bounds.south],
        [bounds.east, bounds.north], [bounds.west, bounds.north],
        [bounds.west, bounds.south],
      ]],
    },
  };
}

function syncArea(): void {
  const [width, height] = dimensionsM(selectedBounds);
  areaInfo.textContent = 'Участок: ' + Math.round(width) + ' × ' + Math.round(height) + ' м (от 50 до 600 м)';
  const source = map.getSource('selection') as maplibregl.GeoJSONSource | undefined;
  source?.setData(boxGeoJson(selectedBounds));
  cachedFeatures = null;
  cachedBounds = '';
  resultStl = null;
  downloadButton.disabled = true;
  stats.textContent = '';
  editor.hidden = true;
  selectedBuilding = null;
  const buildingSource = map.getSource('footprints') as maplibregl.GeoJSONSource | undefined;
  buildingSource?.setData({ type: 'FeatureCollection', features: [] });
}

function currentSettings(): ModelSettings {
  return {
    sizeMm: Number(sizeInput.value),
    terrainScale: Number(terrainInput.value),
    label: labelInput.value.trim(),
    heightOverrides: { ...heightOverrides },
  };
}

function selectArea(bounds: Bounds): void {
  if (!validBounds(bounds)) {
    message('Размер участка должен быть от 50 до 600 м по каждой стороне и не пересекать 180-й меридиан.', true);
    return;
  }
  selectedBounds = bounds;
  syncArea();
  message('Участок выбран. Нажмите «Создать миниатюру».');
}

maplibregl.setWorkerUrl(mapWorkerUrl);
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [37.6176, 55.7558],
  zoom: 14.5,
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.on('load', () => {
  map.addSource('selection', { type: 'geojson', data: boxGeoJson(selectedBounds) });
  map.addLayer({
    id: 'selection-fill', type: 'fill', source: 'selection',
    paint: { 'fill-color': '#eac08a', 'fill-opacity': 0.13 },
  });
  map.addLayer({
    id: 'selection-line', type: 'line', source: 'selection',
    paint: { 'line-color': '#e9b880', 'line-width': 2, 'line-dasharray': [3, 2] },
  });
  map.addSource('footprints', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'footprints', type: 'fill', source: 'footprints',
    paint: { 'fill-color': '#d48d5a', 'fill-opacity': 0.28 },
  });
  map.on('click', 'footprints', event => {
    if (drawing || !event.features?.length || !cachedFeatures) return;
    const id = String(event.features[0].properties?.id ?? '');
    const feature = cachedFeatures.find(item => item.id === id);
    if (!feature) return;
    selectedBuilding = feature;
    editor.hidden = false;
    buildingId.textContent = 'Здание ' + id;
    const stored = heightOverrides[id];
    const explicit = Number.parseFloat(feature.tags.height ?? '');
    const levels = Number.parseFloat(feature.tags['building:levels'] ?? '');
    buildingHeight.value = String(stored ??
      (Number.isFinite(explicit) && explicit > 0 ? explicit :
        Number.isFinite(levels) && levels > 0 ? levels * 3 : 9));
  });
});
map.on('mousemove', event => {
  coordinates.textContent = event.lngLat.lat.toFixed(5) + '° N · ' + event.lngLat.lng.toFixed(5) + '° E';
  if (!drawing || !drawStart) return;
  const bounds: Bounds = {
    west: Math.min(drawStart[0], event.lngLat.lng),
    south: Math.min(drawStart[1], event.lngLat.lat),
    east: Math.max(drawStart[0], event.lngLat.lng),
    north: Math.max(drawStart[1], event.lngLat.lat),
  };
  (map.getSource('selection') as maplibregl.GeoJSONSource | undefined)?.setData(boxGeoJson(bounds));
});
map.on('mousedown', event => {
  if (drawing) drawStart = [event.lngLat.lng, event.lngLat.lat];
});
map.on('mouseup', event => {
  if (!drawing || !drawStart) return;
  const bounds: Bounds = {
    west: Math.min(drawStart[0], event.lngLat.lng),
    south: Math.min(drawStart[1], event.lngLat.lat),
    east: Math.max(drawStart[0], event.lngLat.lng),
    north: Math.max(drawStart[1], event.lngLat.lat),
  };
  drawStart = null;
  drawing = false;
  drawButton.textContent = 'Нарисовать область';
  map.dragPan.enable();
  map.getCanvas().style.cursor = '';
  selectArea(bounds);
  if (!validBounds(bounds)) {
    (map.getSource('selection') as maplibregl.GeoJSONSource | undefined)?.setData(boxGeoJson(selectedBounds));
  }
});

drawButton.addEventListener('click', () => {
  drawing = !drawing;
  drawStart = null;
  drawButton.textContent = drawing ? 'Отменить рисование' : 'Нарисовать область';
  map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
  if (drawing) map.dragPan.disable();
  else map.dragPan.enable();
});
centerButton.addEventListener('click', () => {
  const point = map.getCenter();
  selectArea(boundsFromCenter([point.lng, point.lat], 400, 400));
});
city.addEventListener('change', () => {
  const [lon, lat] = city.value.split(',').map(Number);
  map.flyTo({ center: [lon, lat], zoom: 14.5 });
  selectArea(boundsFromCenter([lon, lat], 400, 400));
});
sizeInput.addEventListener('input', () => { sizeValue.textContent = sizeInput.value + ' мм'; downloadButton.disabled = true; });
terrainInput.addEventListener('input', () => { terrainValue.textContent = terrainInput.value + '×'; downloadButton.disabled = true; });
labelInput.addEventListener('input', () => { downloadButton.disabled = true; });

function showFootprints(features: Feature[]): void {
  const collection: FeatureCollection<Polygon> = {
    type: 'FeatureCollection',
    features: features.filter(feature => feature.kind === 'building').map(feature => ({
      type: 'Feature',
      properties: { id: feature.id },
      geometry: { type: 'Polygon', coordinates: [feature.points] },
    })),
  };
  (map.getSource('footprints') as maplibregl.GeoJSONSource | undefined)?.setData(collection);
}

async function makeModel(): Promise<void> {
  if (busy) return;
  if (!validBounds(selectedBounds)) {
    message('Выберите участок размером от 50 до 600 м.', true);
    return;
  }
  busy = true;
  generateButton.disabled = true;
  downloadButton.disabled = true;
  resultStl = null;
  stats.textContent = '';
  try {
    if (!cachedFeatures || cachedBounds !== boundsKey(selectedBounds)) {
      message('Загружаю здания и улицы OpenStreetMap…');
      const loaded = await loadFeatures(selectedBounds);
      cachedFeatures = loaded.features;
      cachedBounds = boundsKey(selectedBounds);
      showFootprints(cachedFeatures);
      message('Данные получены через ' + loaded.source + '. Загружаю рельеф и строю модель…');
    } else {
      message('Перестраиваю модель с новыми параметрами…');
    }
    const request: BuildRequest = {
      bounds: selectedBounds,
      features: cachedFeatures,
      settings: currentSettings(),
    };
    const built = await new Promise<BuildResult>((resolve, reject) => {
      activeWorker?.terminate();
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      activeWorker = worker;
      worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: BuildResult; error?: string }>) => {
        worker.terminate();
        activeWorker = null;
        if (event.data.ok && event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error ?? 'Не удалось построить модель.'));
      };
      worker.onerror = () => {
        worker.terminate();
        activeWorker = null;
        reject(new Error('Ошибка вычисления геометрии в браузере.'));
      };
      worker.postMessage(request);
    });
    showModel(built);
    resultStl = built.stl;
    downloadButton.disabled = false;
    message('Модель готова. Проверьте её со всех сторон и скачайте STL.');
    const dimensions = built.size.map(value => value.toFixed(1)).join(' × ');
    stats.textContent = dimensions + ' мм · ' + built.triangleCount.toLocaleString('ru-RU') +
      ' треугольников · приблизительная высота у ' + built.missingHeights +
      ' зданий' + (built.omittedBuildings ? ' · пропущено мелких: ' + built.omittedBuildings : '');
  } catch (error) {
    message(error instanceof Error ? error.message : 'Не удалось создать миниатюру.', true);
  } finally {
    busy = false;
    generateButton.disabled = false;
  }
}

generateButton.addEventListener('click', () => { void makeModel(); });
applyHeight.addEventListener('click', () => {
  if (!selectedBuilding) return;
  const height = Number(buildingHeight.value);
  if (!Number.isFinite(height) || height < 1 || height > 500) {
    message('Укажите высоту от 1 до 500 м.', true);
    return;
  }
  heightOverrides[selectedBuilding.id] = height;
  void makeModel();
});
downloadButton.addEventListener('click', () => {
  if (!resultStl) return;
  const url = URL.createObjectURL(new Blob([resultStl], { type: 'model/stl' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'russia-city-miniature.stl';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const scene = new THREE.Scene();
scene.background = new THREE.Color('#17232b');
const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
preview.appendChild(renderer.domElement);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 20;
scene.add(new THREE.HemisphereLight(0xffffff, 0x34404a, 2.4));
const sun = new THREE.DirectionalLight(0xffe3bf, 2.3);
sun.position.set(-90, -50, 180);
scene.add(sun);
let model: THREE.Mesh | null = null;

function showModel(built: BuildResult): void {
  if (model) {
    scene.remove(model);
    model.geometry.dispose();
    (model.material as THREE.Material).dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(built.colors, 3, true));
  geometry.computeVertexNormals();
  model = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.94, metalness: 0,
  }));
  scene.add(model);
  const [width, height, depth] = built.size;
  const center = new THREE.Vector3(width / 2, height / 2, depth / 3);
  orbit.target.copy(center);
  const distance = Math.max(width, height) * 1.15;
  camera.position.set(center.x + distance * 0.8, center.y - distance, center.z + distance * 0.62);
  camera.near = 0.1;
  camera.far = distance * 10;
  camera.updateProjectionMatrix();
  orbit.update();
  previewEmpty.hidden = true;
}

function resize(): void {
  const width = preview.clientWidth;
  const height = preview.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(preview);
function animate(): void {
  orbit.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
