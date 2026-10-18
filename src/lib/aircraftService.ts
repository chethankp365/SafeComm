/**
 * SafeComm — Real Aircraft ADS-B Surveillance Service
 * 
 * Integrates with open-data ADS-B feed (adsb.fi) to retrieve, deduplicate,
 * normalize, and project live aircraft telemetry onto the radar scope.
 */

import { supabase } from './supabase';

export interface RadarCenterConfig {
  id: string;
  name: string;
  icao: string;
  lat: number;
  lon: number;
  description: string;
}

export const RADAR_CENTERS: RadarCenterConfig[] = [
  {
    id: 'KSFO',
    name: 'San Francisco Intl',
    icao: 'KSFO',
    lat: 37.6213,
    lon: -122.3790,
    description: 'San Francisco TRACON Area',
  },
  {
    id: 'EGLL',
    name: 'London Heathrow',
    icao: 'EGLL',
    lat: 51.4700,
    lon: -0.4543,
    description: 'London TMA Airspace',
  },
  {
    id: 'KJFK',
    name: 'New York JFK',
    icao: 'KJFK',
    lat: 40.6413,
    lon: -73.7781,
    description: 'New York TRACON Airspace',
  },
  {
    id: 'KLAX',
    name: 'Los Angeles Intl',
    icao: 'KLAX',
    lat: 33.9416,
    lon: -118.4085,
    description: 'SoCal TRACON Area',
  },
];

export interface LiveAircraft {
  hex: string;
  callsign: string;
  hasCallsign: boolean;
  lat: number;
  lon: number;
  altBaro: number | 'ground' | null;
  altGeom: number | null;
  groundSpeed: number | null;
  track: number | null;
  verticalRate: number | null;
  squawk: string | null;
  category: string | null;
  aircraftType: string | null;
  aircraftDesc: string | null;
  registration: string | null;
  operator: string | null;
  emergency: string | null;
  seenPos: number | null;
  distanceNM: number;
  bearingDeg: number;
  providerSource: 'adsb.fi';
  lastFetchTime: string;
}

export interface AircraftFetchResult {
  aircraft: LiveAircraft[];
  totalReported: number;
  providerTime: number | null;
  isStale: boolean;
  error: string | null;
}

export interface RadarPosition {
  x: number; // Pixels from canvas center
  y: number; // Pixels from canvas center
  distanceNM: number;
  bearingDeg: number;
  inRange: boolean;
}

/**
 * Calculate distance (NM) and bearing (deg) from radar center to aircraft
 * using equirectangular projection (flat-Earth approximation valid within radar coverage).
 */
export function calculateGeographicOffset(
  centerLat: number,
  centerLon: number,
  targetLat: number,
  targetLon: number
): { deltaXNM: number; deltaYNM: number; distanceNM: number; bearingDeg: number } {
  // 1 degree latitude = 60 NM
  const deltaYNM = (targetLat - centerLat) * 60;

  // 1 degree longitude = 60 * cos(lat) NM
  const latRad = (centerLat * Math.PI) / 180;
  const deltaXNM = (targetLon - centerLon) * 60 * Math.cos(latRad);

  const distanceNM = Math.hypot(deltaXNM, deltaYNM);

  // Bearing where 0° is North (positive Y), 90° East (positive X)
  let bearingRad = Math.atan2(deltaXNM, deltaYNM);
  let bearingDeg = (bearingRad * 180) / Math.PI;
  if (bearingDeg < 0) bearingDeg += 360;

  return { deltaXNM, deltaYNM, distanceNM, bearingDeg };
}

/**
 * Calculate canvas radar coordinates from geographic coordinates
 */
export function calculateRadarCanvasPosition(
  centerLat: number,
  centerLon: number,
  targetLat: number,
  targetLon: number,
  rangeNM: number,
  maxRadiusPx: number
): RadarPosition {
  const { deltaXNM, deltaYNM, distanceNM, bearingDeg } = calculateGeographicOffset(
    centerLat,
    centerLon,
    targetLat,
    targetLon
  );

  const inRange = distanceNM <= rangeNM;

  // Canvas coordinates: North is -Y, East is +X
  const x = (deltaXNM / rangeNM) * maxRadiusPx || 0;
  const y = -(deltaYNM / rangeNM) * maxRadiusPx || 0;

  return {
    x,
    y,
    distanceNM: Math.round(distanceNM * 10) / 10,
    bearingDeg: Math.round(bearingDeg),
    inRange,
  };
}

/**
 * Normalize raw aircraft object from adsb.fi
 */
export function normalizeAdsbAircraft(
  raw: any,
  centerLat: number,
  centerLon: number,
  fetchIsoTime: string
): LiveAircraft | null {
  if (!raw || typeof raw !== 'object') return null;

  // 1. ICAO Hex Identifier (mandatory primary key)
  const rawHex = typeof raw.hex === 'string' ? raw.hex.trim() : '';
  if (!rawHex || !/^[0-9a-fA-F]{3,6}$/.test(rawHex)) return null;
  const hex = rawHex.toUpperCase();

  // 2. Latitude & Longitude (mandatory for plotting)
  const lat = typeof raw.lat === 'number' ? raw.lat : parseFloat(raw.lat);
  const lon = typeof raw.lon === 'number' ? raw.lon : parseFloat(raw.lon);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  // 3. Callsign / Identification
  const rawFlight = typeof raw.flight === 'string' ? raw.flight.trim() : '';
  const hasCallsign = rawFlight.length > 0;
  const callsign = hasCallsign ? rawFlight : `HEX:${hex}`;

  // 4. Barometric Altitude
  let altBaro: number | 'ground' | null = null;
  if (raw.alt_baro === 'ground') {
    altBaro = 'ground';
  } else if (typeof raw.alt_baro === 'number' && Number.isFinite(raw.alt_baro)) {
    altBaro = Math.round(raw.alt_baro);
  } else if (typeof raw.alt_baro === 'string') {
    const parsed = parseInt(raw.alt_baro, 10);
    if (!isNaN(parsed)) altBaro = parsed;
  }

  // 5. Geometric Altitude
  let altGeom: number | null = null;
  if (typeof raw.alt_geom === 'number' && Number.isFinite(raw.alt_geom)) {
    altGeom = Math.round(raw.alt_geom);
  }

  // 6. Ground Speed
  let groundSpeed: number | null = null;
  if (typeof raw.gs === 'number' && Number.isFinite(raw.gs) && raw.gs >= 0) {
    groundSpeed = Math.round(raw.gs * 10) / 10;
  }

  // 7. Track / Heading
  let track: number | null = null;
  const rawTrack = typeof raw.track === 'number' ? raw.track : typeof raw.true_heading === 'number' ? raw.true_heading : null;
  if (rawTrack !== null && Number.isFinite(rawTrack)) {
    track = Math.round(((rawTrack % 360) + 360) % 360);
  }

  // 8. Vertical Rate
  let verticalRate: number | null = null;
  const rawRate = typeof raw.baro_rate === 'number' ? raw.baro_rate : typeof raw.geom_rate === 'number' ? raw.geom_rate : null;
  if (rawRate !== null && Number.isFinite(rawRate)) {
    verticalRate = Math.round(rawRate);
  }

  // 9. Squawk
  const squawk = typeof raw.squawk === 'string' && raw.squawk.trim().length > 0 ? raw.squawk.trim() : null;

  // 10. Metadata (Category, Registration, Type, Operator)
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : null;
  const aircraftType = typeof raw.t === 'string' && raw.t.trim() ? raw.t.trim() : null;
  const aircraftDesc = typeof raw.desc === 'string' && raw.desc.trim() ? raw.desc.trim() : null;
  const registration = typeof raw.r === 'string' && raw.r.trim() ? raw.r.trim() : null;
  const operator = typeof raw.ownOp === 'string' && raw.ownOp.trim() ? raw.ownOp.trim() : null;
  const emergency = typeof raw.emergency === 'string' && raw.emergency !== 'none' ? raw.emergency.trim() : null;

  // 11. Position age
  const seenPos = typeof raw.seen_pos === 'number' && Number.isFinite(raw.seen_pos) ? Math.round(raw.seen_pos * 10) / 10 : null;

  // Calculate distance & bearing
  const { distanceNM, bearingDeg } = calculateGeographicOffset(centerLat, centerLon, lat, lon);

  return {
    hex,
    callsign,
    hasCallsign,
    lat,
    lon,
    altBaro,
    altGeom,
    groundSpeed,
    track,
    verticalRate,
    squawk,
    category,
    aircraftType,
    aircraftDesc,
    registration,
    operator,
    emergency,
    seenPos,
    distanceNM: Math.round(distanceNM * 10) / 10,
    bearingDeg: Math.round(bearingDeg),
    providerSource: 'adsb.fi',
    lastFetchTime: fetchIsoTime,
  };
}

/**
 * Deduplicate raw aircraft array by ICAO hex and normalize
 */
export function processRawAircraftPayload(
  payload: any,
  centerLat: number,
  centerLon: number,
  fetchIsoTime: string
): { aircraft: LiveAircraft[]; totalReported: number; providerTime: number | null } {
  if (!payload || typeof payload !== 'object') {
    return { aircraft: [], totalReported: 0, providerTime: null };
  }

  const rawList: any[] = Array.isArray(payload.ac) ? payload.ac : [];
  const providerTime = typeof payload.now === 'number' ? payload.now : null;
  const totalReported = typeof payload.total === 'number' ? payload.total : rawList.length;

  // Map keyed by ICAO hex to ensure deduplication
  const hexMap = new Map<string, LiveAircraft>();

  for (const item of rawList) {
    const normalized = normalizeAdsbAircraft(item, centerLat, centerLon, fetchIsoTime);
    if (!normalized) continue;

    // Deduplicate: if duplicate hex exists, keep the one with newer seen_pos
    const existing = hexMap.get(normalized.hex);
    if (!existing) {
      hexMap.set(normalized.hex, normalized);
    } else if (
      normalized.seenPos !== null &&
      (existing.seenPos === null || normalized.seenPos < existing.seenPos)
    ) {
      hexMap.set(normalized.hex, normalized);
    }
  }

  const aircraft = Array.from(hexMap.values());
  return { aircraft, totalReported, providerTime };
}

// Client-side cache to protect upstream provider rate limit (minimum 2s cooldown)
let lastFetchTimestamp = 0;
let cachedResult: AircraftFetchResult | null = null;
const CLIENT_CACHE_MIN_INTERVAL_MS = 2000;

/**
 * Fetch live nearby aircraft from adsb.fi
 * Uses Vite proxy in development or Supabase Edge Function in production.
 */
export async function fetchLiveNearbyAircraft(
  centerLat: number,
  centerLon: number,
  distNM: number = 25,
  signal?: AbortSignal
): Promise<AircraftFetchResult> {
  const now = Date.now();

  // Return cached result if called faster than min interval
  if (cachedResult && now - lastFetchTimestamp < CLIENT_CACHE_MIN_INTERVAL_MS) {
    return cachedResult;
  }

  const fetchIsoTime = new Date().toISOString();

  // Strategy 1: In dev / Vite proxy, call /api/adsb
  const isDev = import.meta.env?.DEV;
  const proxyUrl = `/api/adsb/v3/lat/${centerLat.toFixed(4)}/lon/${centerLon.toFixed(4)}/dist/${distNM}`;

  try {
    let responseData: any = null;

    if (isDev) {
      try {
        const res = await fetch(proxyUrl, {
          signal,
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          responseData = await res.json();
        }
      } catch (e) {
        // Fall back to Supabase function if proxy failed
      }
    }

    // Strategy 2: Call Supabase Edge Function 'live-aircraft'
    if (!responseData) {
      const { data, error } = await supabase.functions.invoke('live-aircraft', {
        body: {
          lat: centerLat,
          lon: centerLon,
          dist: distNM,
        },
      });

      if (error) {
        throw new Error(error.message || 'Supabase Edge Function failed');
      }
      responseData = data;
    }

    const { aircraft, totalReported, providerTime } = processRawAircraftPayload(
      responseData,
      centerLat,
      centerLon,
      fetchIsoTime
    );

    lastFetchTimestamp = now;
    cachedResult = {
      aircraft,
      totalReported,
      providerTime,
      isStale: false,
      error: null,
    };

    return cachedResult;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to fetch live aircraft';
    console.warn('[SafeComm Aircraft] Fetch error:', errorMsg);

    // If we have previous successful data, return it marked as stale
    if (cachedResult && cachedResult.aircraft.length > 0) {
      return {
        ...cachedResult,
        isStale: true,
        error: errorMsg,
      };
    }

    return {
      aircraft: [],
      totalReported: 0,
      providerTime: null,
      isStale: false,
      error: errorMsg,
    };
  }
}
