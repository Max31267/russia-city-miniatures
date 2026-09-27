import type { Bounds, Point } from './types';

const EARTH_RADIUS = 6378137;
const TO_RAD = Math.PI / 180;

export function boundsFromCenter(center: Point, widthM: number, heightM: number): Bounds {
  const dLat = heightM / EARTH_RADIUS / TO_RAD / 2;
  const dLon = widthM / (EARTH_RADIUS * Math.cos(center[1] * TO_RAD)) / TO_RAD / 2;
  return {
    west: center[0] - dLon,
    south: center[1] - dLat,
    east: center[0] + dLon,
    north: center[1] + dLat,
  };
}

export function dimensionsM(bounds: Bounds): [number, number] {
  const midLat = (bounds.south + bounds.north) / 2;
  return [
    (bounds.east - bounds.west) * TO_RAD * EARTH_RADIUS * Math.cos(midLat * TO_RAD),
    (bounds.north - bounds.south) * TO_RAD * EARTH_RADIUS,
  ];
}

export function project(point: Point, bounds: Bounds, mmPerM: number): Point {
  const midLat = (bounds.south + bounds.north) / 2;
  return [
    (point[0] - bounds.west) * TO_RAD * EARTH_RADIUS * Math.cos(midLat * TO_RAD) * mmPerM,
    (point[1] - bounds.south) * TO_RAD * EARTH_RADIUS * mmPerM,
  ];
}

export function validBounds(bounds: Bounds): boolean {
  const [width, height] = dimensionsM(bounds);
  return bounds.west >= -180 && bounds.east <= 180 &&
    bounds.south >= -85 && bounds.north <= 85 &&
    bounds.west < bounds.east && bounds.south < bounds.north &&
    width >= 50 && height >= 50 && width <= 600 && height <= 600;
}
