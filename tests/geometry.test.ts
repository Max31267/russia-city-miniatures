import { describe, expect, it } from 'vitest';
import Module from 'manifold-3d';
import { buildGeometry } from '../src/geometry';
import type { BuildRequest } from '../src/types';

const bounds = { west: 37.6, south: 55.7, east: 37.603, north: 55.702 };
const request: BuildRequest = {
  bounds,
  features: [
    {
      id: 'way/1',
      kind: 'building',
      points: [
        [37.601, 55.7007], [37.6015, 55.7007], [37.6015, 55.7012],
        [37.601, 55.7012], [37.601, 55.7007],
      ],
      tags: { building: 'yes', height: '15' },
    },
    {
      id: 'way/2',
      kind: 'road',
      points: [[37.6, 55.7015], [37.603, 55.7015]],
      tags: { highway: 'residential' },
    },
  ],
  settings: { sizeMm: 120, terrainScale: 1, label: '', heightOverrides: {} },
};

describe('печатаемая геометрия', () => {
  it('создаёт одну замкнутую STL-модель с основанием и зданием', async () => {
    const kernel = await Module();
    kernel.setup();
    const model = buildGeometry(request, () => 100, kernel);
    expect(model.triangleCount).toBeGreaterThan(100);
    expect(model.stl.byteLength).toBe(84 + model.triangleCount * 50);
    expect(model.size[0]).toBeGreaterThan(100);
    expect(model.size[0]).toBeLessThan(120);
    expect(model.size[1]).toBeCloseTo(120, 0);
    expect(model.size[2]).toBeGreaterThan(10);
    expect(model.missingHeights).toBe(0);
  });

  it('учитывает ручную правку высоты', async () => {
    const kernel = await Module();
    kernel.setup();
    const original = buildGeometry(request, () => 100, kernel);
    const taller = buildGeometry({
      ...request,
      settings: { ...request.settings, heightOverrides: { 'way/1': 40 } },
    }, () => 100, kernel);
    expect(taller.size[2]).toBeGreaterThan(original.size[2] + 10);
  });
});
