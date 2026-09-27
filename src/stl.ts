import type { Mesh } from 'manifold-3d';

export function binaryStl(mesh: Mesh): ArrayBuffer {
  const count = mesh.triVerts.length / 3;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const header = new TextEncoder().encode(
    'Russia City Miniatures | OSM contributors ODbL | Mapzen Terrain Tiles | mm',
  );
  new Uint8Array(buffer).set(header.subarray(0, 80));
  view.setUint32(80, count, true);
  const stride = mesh.numProp;
  const vertices = mesh.vertProperties;
  const indices = mesh.triVerts;
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50;
    const corners = [0, 1, 2].map(corner => {
      const index = indices[i * 3 + corner] * stride;
      return [vertices[index], vertices[index + 1], vertices[index + 2]];
    });
    const ab = corners[1].map((v, k) => v - corners[0][k]);
    const ac = corners[2].map((v, k) => v - corners[0][k]);
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(...cross) || 1;
    for (let k = 0; k < 3; k++) view.setFloat32(base + k * 4, cross[k] / length, true);
    for (let corner = 0; corner < 3; corner++) {
      for (let k = 0; k < 3; k++) {
        view.setFloat32(base + 12 + corner * 12 + k * 4, corners[corner][k], true);
      }
    }
  }
  return buffer;
}
