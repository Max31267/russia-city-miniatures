/// <reference lib="webworker" />
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { buildGeometry } from './geometry';
import { loadTerrain } from './terrain';
import type { BuildRequest } from './types';

function rasterLabel(value: string): boolean[][] {
  const text = value.trim().slice(0, 20);
  if (!text) return [];
  const canvas = new OffscreenCanvas(600, 64);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [];
  context.font = 'bold 42px Arial, sans-serif';
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#fff';
  context.fillText(text, 4, 47);
  const image = context.getImageData(0, 0, 600, 64);
  let minX = 600;
  let maxX = -1;
  let minY = 64;
  let maxY = -1;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 600; x++) {
      if (image.data[(y * 600 + x) * 4 + 3] > 128) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return [];
  const rows: boolean[][] = [];
  for (let y = minY; y <= maxY; y += 2) {
    const row: boolean[] = [];
    for (let x = minX; x <= maxX; x += 2) {
      let active = false;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(599, x + dx);
          const py = Math.min(63, y + dy);
          active ||= image.data[(py * 600 + px) * 4 + 3] > 128;
        }
      }
      row.push(active);
    }
    rows.push(row);
  }
  return rows;
}

self.onmessage = async (event: MessageEvent<BuildRequest>) => {
  try {
    const request = event.data;
    const elevation = await loadTerrain(request.bounds);
    const kernel = await Module({ locateFile: () => wasmUrl });
    kernel.setup();
    const result = buildGeometry(request, elevation, kernel, rasterLabel(request.settings.label));
    self.postMessage({ ok: true, result }, [result.positions.buffer, result.colors.buffer, result.stl]);
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Неизвестная ошибка построения модели.',
    });
  }
};
