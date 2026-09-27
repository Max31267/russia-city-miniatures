export type Point = [number, number]; // longitude, latitude

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Feature {
  id: string;
  kind: 'building' | 'road' | 'water' | 'park';
  points: Point[];
  tags: Record<string, string>;
}

export interface ModelSettings {
  sizeMm: number;
  terrainScale: number;
  label: string;
  heightOverrides: Record<string, number>;
}

export interface BuildRequest {
  bounds: Bounds;
  features: Feature[];
  settings: ModelSettings;
}

export interface BuildResult {
  positions: Float32Array;
  colors: Uint8Array;
  stl: ArrayBuffer;
  missingHeights: number;
  omittedBuildings: number;
  triangleCount: number;
  size: [number, number, number];
}
