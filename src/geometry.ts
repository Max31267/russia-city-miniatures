import type { ManifoldToplevel, Manifold, Mesh } from 'manifold-3d';
import { dimensionsM, project } from './geo';
import { binaryStl } from './stl';
import type { Bounds, BuildRequest, BuildResult, Feature, Point } from './types';

interface ProjectedFeature {
  id: string;
  kind: Feature['kind'];
  points: Point[];
  tags: Record<string, string>;
  box: [number, number, number, number];
  width: number;
}

const BASE_Z = 3.6;
const BUILDING_START_Z = 2.8;
const GRID_MM = 1.6;
const MAX_BUILDINGS = 1500;

function boundsOf(points: Point[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

function roadWidth(feature: Feature, mmPerM: number): number {
  const explicit = Number.parseFloat(feature.tags.width ?? '');
  const defaults: Record<string, number> = {
    motorway: 18, trunk: 14, primary: 12, secondary: 10, tertiary: 8,
    residential: 6, unclassified: 6, service: 4, living_street: 4,
    pedestrian: 3, footway: 2, path: 2, cycleway: 2,
  };
  const meters = Number.isFinite(explicit) && explicit > 0 ? explicit :
    (defaults[feature.tags.highway] ?? 3);
  return Math.max(0.8, meters * mmPerM);
}

function projectFeatures(features: Feature[], bounds: Bounds, mmPerM: number): ProjectedFeature[] {
  return features.map(feature => {
    const points = feature.points.map(point => project(point, bounds, mmPerM));
    return {
      id: feature.id,
      kind: feature.kind,
      points,
      tags: feature.tags,
      box: boundsOf(points),
      width: feature.kind === 'road' ? roadWidth(feature, mmPerM) : 0,
    };
  });
}

function inside(x: number, y: number, points: Point[]): boolean {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      result = !result;
    }
  }
  return result;
}

function pathDistanceSq(x: number, y: number, points: Point[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const px = ax + t * dx;
    const py = ay + t * dy;
    best = Math.min(best, (x - px) ** 2 + (y - py) ** 2);
  }
  return best;
}

type SurfaceKind = 'water' | 'road' | 'park' | 'ground';

function surfaceKind(x: number, y: number, features: ProjectedFeature[]): SurfaceKind {
  let park = false;
  let road = false;
  for (const feature of features) {
    if (feature.kind === 'building') continue;
    const pad = feature.kind === 'road' ? feature.width / 2 : 0;
    if (x < feature.box[0] - pad || x > feature.box[2] + pad ||
      y < feature.box[1] - pad || y > feature.box[3] + pad) continue;
    if (feature.kind === 'water' && inside(x, y, feature.points)) return 'water';
    if (feature.kind === 'park' && inside(x, y, feature.points)) park = true;
    if (feature.kind === 'road' &&
      pathDistanceSq(x, y, feature.points) <= (feature.width / 2) ** 2) road = true;
  }
  return road ? 'road' : park ? 'park' : 'ground';
}

function heightMeters(feature: ProjectedFeature, overrides: Record<string, number>): [number, boolean] {
  const override = overrides[feature.id];
  if (Number.isFinite(override) && override >= 1 && override <= 500) return [override, false];
  const height = Number.parseFloat(feature.tags.height ?? '');
  if (Number.isFinite(height) && height > 0 && height <= 500) return [height, false];
  const levels = Number.parseFloat(feature.tags['building:levels'] ?? '');
  if (Number.isFinite(levels) && levels > 0 && levels <= 150) return [levels * 3, false];
  return [9, true];
}

function addVertex(values: number[], x: number, y: number, z: number): number {
  const index = values.length / 3;
  values.push(x, y, z);
  return index;
}

function terrainMesh(
  width: number, height: number, nx: number, ny: number,
  heights: Float32Array, MeshClass: typeof Mesh,
): Mesh {
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      addVertex(vertices, i / nx * width, j / ny * height, heights[j * (nx + 1) + i]);
    }
  }
  const top = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = top(i, j);
      const b = top(i + 1, j);
      const c = top(i, j + 1);
      const d = top(i + 1, j + 1);
      triangles.push(a, b, d, a, d, c);
    }
  }
  const boundary: number[] = [];
  for (let i = 0; i <= nx; i++) boundary.push(top(i, 0));
  for (let j = 1; j <= ny; j++) boundary.push(top(nx, j));
  for (let i = nx - 1; i >= 0; i--) boundary.push(top(i, ny));
  for (let j = ny - 1; j >= 1; j--) boundary.push(top(0, j));
  const bottoms = boundary.map(index => addVertex(
    vertices, vertices[index * 3], vertices[index * 3 + 1], 0,
  ));
  const center = addVertex(vertices, width / 2, height / 2, 0);
  for (let i = 0; i < boundary.length; i++) {
    const next = (i + 1) % boundary.length;
    triangles.push(boundary[i], bottoms[i], boundary[next]);
    triangles.push(boundary[next], bottoms[i], bottoms[next]);
    triangles.push(center, bottoms[next], bottoms[i]);
  }
  return new MeshClass({
    numProp: 3,
    vertProperties: new Float32Array(vertices),
    triVerts: new Uint32Array(triangles),
  });
}

function trianglePreview(
  mesh: Mesh,
  width: number,
  height: number,
  terrainAt: (x: number, y: number) => number,
  features: ProjectedFeature[],
  frameTop: number,
  hasLabel: boolean,
): { positions: Float32Array; colors: Uint8Array } {
  const count = mesh.triVerts.length / 3;
  const positions = new Float32Array(count * 9);
  const colors = new Uint8Array(count * 9);
  const palette: Record<string, [number, number, number]> = {
    frame: [37, 43, 50], building: [198, 145, 100], water: [45, 158, 203],
    road: [83, 98, 107], park: [79, 165, 118], ground: [208, 196, 167],
    underside: [65, 68, 65], label: [239, 244, 234],
  };
  const stride = mesh.numProp;
  for (let tri = 0; tri < count; tri++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const xyz: number[][] = [];
    for (let corner = 0; corner < 3; corner++) {
      const index = mesh.triVerts[tri * 3 + corner] * stride;
      const vertex = [
        mesh.vertProperties[index],
        mesh.vertProperties[index + 1],
        mesh.vertProperties[index + 2],
      ];
      xyz.push(vertex);
      cx += vertex[0] / 3;
      cy += vertex[1] / 3;
      cz += vertex[2] / 3;
      positions.set(vertex, tri * 9 + corner * 3);
    }
    const ux = xyz[1][0] - xyz[0][0];
    const uy = xyz[1][1] - xyz[0][1];
    const vx = xyz[2][0] - xyz[0][0];
    const vy = xyz[2][1] - xyz[0][1];
    const normalZ = ux * vy - uy * vx;
    let name: string;
    const plaque = hasLabel && cx > width - Math.min(66, width - 8) - 4 && cy > height - 11;
    if (normalZ < -0.001) name = 'underside';
    else if (plaque && cz > frameTop + 0.9) name = 'label';
    else if (plaque || cx < 4.1 || cy < 4.1 || cx > width - 4.1 || cy > height - 4.1) name = 'frame';
    else if (cz > terrainAt(cx, cy) + 0.45) name = 'building';
    else name = surfaceKind(cx, cy, features);
    const color = palette[name] ?? palette.ground;
    for (let corner = 0; corner < 3; corner++) colors.set(color, tri * 9 + corner * 3);
  }
  return { positions, colors };
}

export function buildGeometry(
  request: BuildRequest,
  elevationAt: (lon: number, lat: number) => number,
  kernel: ManifoldToplevel,
  labelPixels?: boolean[][],
): BuildResult {
  const [widthM, heightM] = dimensionsM(request.bounds);
  const mmPerM = request.settings.sizeMm / Math.max(widthM, heightM);
  const width = widthM * mmPerM;
  const height = heightM * mmPerM;
  const features = projectFeatures(request.features, request.bounds, mmPerM);
  const buildings = features.filter(feature => feature.kind === 'building');
  if (buildings.length > MAX_BUILDINGS) {
    throw new Error('Более 1500 зданий. Выберите участок меньше.');
  }

  const nx = Math.ceil(width / GRID_MM);
  const ny = Math.ceil(height / GRID_MM);
  const elevations = new Float32Array((nx + 1) * (ny + 1));
  let lowest = Infinity;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const lon = request.bounds.west + i / nx * (request.bounds.east - request.bounds.west);
      const lat = request.bounds.south + j / ny * (request.bounds.north - request.bounds.south);
      const value = elevationAt(lon, lat);
      elevations[j * (nx + 1) + i] = value;
      lowest = Math.min(lowest, value);
    }
  }

  function ground(x: number, y: number): number {
    const lon = request.bounds.west + x / width * (request.bounds.east - request.bounds.west);
    const lat = request.bounds.south + y / height * (request.bounds.north - request.bounds.south);
    return BASE_Z + (elevationAt(lon, lat) - lowest) * mmPerM * request.settings.terrainScale;
  }

  function terrainAt(x: number, y: number): number {
    const kind = surfaceKind(x, y, features);
    const cut = kind === 'water' ? 0.45 : kind === 'road' ? 0.25 : kind === 'park' ? 0.12 : 0;
    return Math.max(3.05, ground(x, y) - cut);
  }

  const heights = new Float32Array(elevations.length);
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      heights[j * (nx + 1) + i] = terrainAt(i / nx * width, j / ny * height);
    }
  }
  const terrain = new kernel.Manifold(terrainMesh(width, height, nx, ny, heights, kernel.Mesh));
  if (terrain.status() !== 'NoError') throw new Error('Не удалось построить замкнутое основание.');
  const solids: Manifold[] = [terrain];
  const area = kernel.CrossSection.square([width, height]);
  let missingHeights = 0;
  let omittedBuildings = 0;

  for (const building of buildings) {
    const [minX, minY, maxX, maxY] = building.box;
    if (maxX < 0 || maxY < 0 || minX > width || minY > height) continue;
    if (maxX - minX < 0.8 || maxY - minY < 0.8) {
      omittedBuildings++;
      continue;
    }
    const section = new kernel.CrossSection([building.points], 'EvenOdd').intersect(area);
    if (section.isEmpty()) {
      section.delete();
      continue;
    }
    const [heightMBuilding, estimated] = heightMeters(building, request.settings.heightOverrides);
    if (estimated) missingHeights++;
    const cx = Math.max(0, Math.min(width, (minX + maxX) / 2));
    const cy = Math.max(0, Math.min(height, (minY + maxY) / 2));
    const topZ = ground(cx, cy) + heightMBuilding * mmPerM;
    solids.push(section.extrude(topZ - BUILDING_START_Z).translate(0, 0, BUILDING_START_Z));
    section.delete();
  }
  area.delete();

  const edgeMax = Math.max(
    ...Array.from({ length: nx + 1 }, (_, i) => Math.max(heights[i], heights[ny * (nx + 1) + i])),
    ...Array.from({ length: ny + 1 }, (_, j) => Math.max(heights[j * (nx + 1)], heights[j * (nx + 1) + nx])),
  );
  const frameTop = edgeMax + 1.5;
  const frameHeight = frameTop - BUILDING_START_Z;
  const bars: Array<[number, number, number, number]> = [
    [0, 0, width, 4], [0, height - 4, width, 4],
    [0, 4, 4, height - 8], [width - 4, 4, 4, height - 8],
  ];
  for (const [x, y, w, h] of bars) {
    solids.push(kernel.Manifold.cube([w, h, frameHeight]).translate(x, y, BUILDING_START_Z));
  }

  if (request.settings.label && labelPixels?.length) {
    const plaqueW = Math.min(66, width - 8);
    const plaqueH = 11;
    const plaqueX = width - plaqueW - 4;
    const plaqueY = height - plaqueH;
    solids.push(kernel.Manifold.cube([plaqueW, plaqueH, frameHeight + 0.7])
      .translate(plaqueX, plaqueY, BUILDING_START_Z));
    const rows = labelPixels.length;
    const cols = labelPixels[0].length;
    const pixelSize = Math.min((plaqueW - 4) / cols, 6.5 / rows);
    const originX = plaqueX + (plaqueW - cols * pixelSize) / 2;
    const originY = plaqueY + (plaqueH - rows * pixelSize) / 2;
    const runs: Point[][] = [];
    for (let row = 0; row < rows; row++) {
      let start = -1;
      for (let col = 0; col <= cols; col++) {
        const active = col < cols && labelPixels[row][col];
        if (active && start < 0) start = col;
        if (!active && start >= 0) {
          const x0 = originX + start * pixelSize;
          const x1 = originX + col * pixelSize;
          const y0 = originY + (rows - row - 1) * pixelSize;
          const y1 = y0 + pixelSize;
          runs.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
          start = -1;
        }
      }
    }
    if (runs.length) {
      const letters = new kernel.CrossSection(runs, 'Positive').offset(0.15);
      solids.push(letters.extrude(0.7).translate(0, 0, frameTop + 0.7));
      letters.delete();
    }
  }

  const result = kernel.Manifold.union(solids);
  for (const solid of solids) solid.delete();
  if (result.status() !== 'NoError' || result.isEmpty()) {
    result.delete();
    throw new Error('Не удалось объединить детали модели.');
  }
  const components = result.decompose();
  const componentCount = components.length;
  for (const component of components) component.delete();
  if (componentCount !== 1) {
    result.delete();
    throw new Error('Модель распалась на отдельные детали. Выберите другой участок.');
  }
  const mesh = result.getMesh();
  const preview = trianglePreview(
    mesh, width, height, terrainAt, features, frameTop, Boolean(request.settings.label),
  );
  const stl = binaryStl(mesh);
  const box = result.boundingBox();
  const triangleCount = result.numTri();
  result.delete();
  return {
    ...preview,
    stl,
    missingHeights,
    omittedBuildings,
    triangleCount,
    size: [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]],
  };
}
