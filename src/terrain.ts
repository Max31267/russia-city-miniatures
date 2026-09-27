import type { Bounds } from './types';

const ZOOM = 13;
const TILE_SIZE = 256;
const TILE_COUNT = 2 ** ZOOM;

function pixelCoordinate(lon: number, lat: number): [number, number] {
  const latitude = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
  return [
    (lon + 180) / 360 * TILE_COUNT * TILE_SIZE,
    (1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2 * TILE_COUNT * TILE_SIZE,
  ];
}

function key(x: number, y: number): string {
  return x + '/' + y;
}

function decode(data: Uint8ClampedArray, index: number): number {
  const offset = index * 4;
  return data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32768;
}

export async function loadTerrain(bounds: Bounds): Promise<(lon: number, lat: number) => number> {
  const [westX, northY] = pixelCoordinate(bounds.west, bounds.north);
  const [eastX, southY] = pixelCoordinate(bounds.east, bounds.south);
  const minTileX = Math.floor((westX - 1) / TILE_SIZE);
  const maxTileX = Math.floor((eastX + 1) / TILE_SIZE);
  const minTileY = Math.floor((northY - 1) / TILE_SIZE);
  const maxTileY = Math.floor((southY + 1) / TILE_SIZE);
  const tileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  if (tileCount > 16) throw new Error('Для этой области требуется слишком много тайлов рельефа.');

  const tiles = new Map<string, Uint8ClampedArray>();
  const requests: Promise<void>[] = [];
  for (let x = minTileX; x <= maxTileX; x++) {
    for (let y = minTileY; y <= maxTileY; y++) {
      requests.push((async () => {
        const url = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/' +
          ZOOM + '/' + x + '/' + y + '.png';
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('Рельеф: HTTP ' + response.status);
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Браузер не поддерживает обработку рельефа.');
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        tiles.set(key(x, y), context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data);
      })());
    }
  }
  await Promise.all(requests);

  function pixel(x: number, y: number): number {
    const tileX = Math.floor(x / TILE_SIZE);
    const tileY = Math.floor(y / TILE_SIZE);
    const data = tiles.get(key(tileX, tileY));
    if (!data) throw new Error('Отсутствует тайл рельефа.');
    const localX = x - tileX * TILE_SIZE;
    const localY = y - tileY * TILE_SIZE;
    const height = decode(data, localY * TILE_SIZE + localX);
    if (!Number.isFinite(height) || height < -1000) {
      throw new Error('Для выбранного участка нет корректных высот.');
    }
    return height;
  }

  return (lon, lat) => {
    const [x, y] = pixelCoordinate(lon, lat);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const dx = x - x0;
    const dy = y - y0;
    const a = pixel(x0, y0) * (1 - dx) + pixel(x0 + 1, y0) * dx;
    const b = pixel(x0, y0 + 1) * (1 - dx) + pixel(x0 + 1, y0 + 1) * dx;
    return a * (1 - dy) + b * dy;
  };
}
