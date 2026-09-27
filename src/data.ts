import type { Bounds, Feature, Point } from './types';

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lon: number; lat: number }>;
  members?: Array<{ role: string; geometry?: Array<{ lon: number; lat: number }> }>;
}

function kindOf(tags: Record<string, string>): Feature['kind'] | null {
  if (tags.building && tags.building !== 'no' || tags['building:part']) return 'building';
  if (tags.highway && tags.highway !== 'proposed' && tags.highway !== 'construction') return 'road';
  if (tags.natural === 'water' || tags.waterway === 'riverbank' || tags.landuse === 'reservoir') return 'water';
  if (tags.leisure === 'park' || tags.landuse === 'grass' || tags.landuse === 'forest') return 'park';
  return null;
}

function asFeature(id: string, tags: Record<string, string>, points: Point[]): Feature | null {
  const kind = kindOf(tags);
  if (!kind || points.length < (kind === 'road' ? 2 : 4)) return null;
  if (kind !== 'road' && (points[0][0] !== points[points.length - 1][0] ||
    points[0][1] !== points[points.length - 1][1])) return null;
  return { id, kind, points, tags };
}

async function fromOverpass(bounds: Bounds): Promise<Feature[]> {
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].join(',');
  const query = '[out:json][timeout:20];(' +
    'way["building"](' + bbox + ');way["building:part"](' + bbox + ');' +
    'way["highway"](' + bbox + ');way["natural"="water"](' + bbox + ');' +
    'way["waterway"="riverbank"](' + bbox + ');way["landuse"="reservoir"](' + bbox + ');' +
    'way["leisure"="park"](' + bbox + ');way["landuse"="grass"](' + bbox + ');' +
    'way["landuse"="forest"](' + bbox + ');' +
    'relation["building"](' + bbox + ');relation["natural"="water"](' + bbox + ');' +
    ');out geom;';
  const response = await fetch(
    'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query),
    { signal: AbortSignal.timeout(14000) },
  );
  if (!response.ok) throw new Error('Overpass: HTTP ' + response.status);
  const payload = await response.json() as { elements: OverpassElement[] };
  const output: Feature[] = [];
  for (const item of payload.elements) {
    const tags = item.tags ?? {};
    if (item.type === 'way' && item.geometry) {
      const feature = asFeature('way/' + item.id, tags, item.geometry.map(p => [p.lon, p.lat]));
      if (feature) output.push(feature);
    }
    if (item.type === 'relation' && item.members) {
      item.members.forEach((member, index) => {
        if (member.role !== 'outer' || !member.geometry) return;
        const feature = asFeature(
          'relation/' + item.id + '/' + index,
          tags,
          member.geometry.map(p => [p.lon, p.lat]),
        );
        if (feature) output.push(feature);
      });
    }
  }
  return output;
}

async function fromOsmApi(bounds: Bounds): Promise<Feature[]> {
  const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].join(',');
  const response = await fetch(
    'https://api.openstreetmap.org/api/0.6/map?bbox=' + bbox,
    { signal: AbortSignal.timeout(25000) },
  );
  if (!response.ok) throw new Error('OpenStreetMap: HTTP ' + response.status);
  const document = new DOMParser().parseFromString(await response.text(), 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Некорректный XML карты');
  const nodes = new Map<string, Point>();
  document.querySelectorAll('node').forEach(node => {
    nodes.set(node.getAttribute('id') ?? '', [
      Number(node.getAttribute('lon')),
      Number(node.getAttribute('lat')),
    ]);
  });
  const output: Feature[] = [];
  document.querySelectorAll('way').forEach(way => {
    const tags: Record<string, string> = {};
    way.querySelectorAll('tag').forEach(tag => {
      const key = tag.getAttribute('k');
      if (key) tags[key] = tag.getAttribute('v') ?? '';
    });
    if (!kindOf(tags)) return;
    const points: Point[] = [];
    way.querySelectorAll('nd').forEach(nd => {
      const point = nodes.get(nd.getAttribute('ref') ?? '');
      if (point) points.push(point);
    });
    const feature = asFeature('way/' + way.getAttribute('id'), tags, points);
    if (feature) output.push(feature);
  });
  return output;
}

export async function loadFeatures(bounds: Bounds): Promise<{ features: Feature[]; source: string }> {
  try {
    const features = await fromOverpass(bounds);
    if (!features.some(feature => feature.kind === 'building')) throw new Error('Нет зданий');
    return { features, source: 'Overpass API' };
  } catch {
    const features = await fromOsmApi(bounds);
    if (!features.some(feature => feature.kind === 'building')) {
      throw new Error('На выбранном участке нет контуров зданий в OpenStreetMap.');
    }
    return { features, source: 'OpenStreetMap API' };
  }
}
