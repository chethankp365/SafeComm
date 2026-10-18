import { describe, it, expect } from 'vitest';
import {
  normalizeAdsbAircraft,
  processRawAircraftPayload,
  calculateGeographicOffset,
  calculateRadarCanvasPosition,
  RADAR_CENTERS,
} from '../lib/aircraftService';

describe('SafeComm ADS-B Aircraft Service & Geographic Positioning', () => {
  const SFO_LAT = 37.6213;
  const SFO_LON = -122.3790;
  const ISO_TIME = '2026-10-18T00:00:00.000Z';

  describe('1. Geographic Projection & Distance/Bearing Calculations', () => {
    it('correctly calculates North offset (positive deltaYNM, bearing 0°)', () => {
      // 0.1 degree North = 6 NM North
      const targetLat = SFO_LAT + 0.1;
      const targetLon = SFO_LON;
      const offset = calculateGeographicOffset(SFO_LAT, SFO_LON, targetLat, targetLon);

      expect(offset.deltaYNM).toBeCloseTo(6.0, 1);
      expect(offset.deltaXNM).toBeCloseTo(0.0, 1);
      expect(offset.distanceNM).toBeCloseTo(6.0, 1);
      expect(offset.bearingDeg).toBeCloseTo(0, 0);
    });

    it('correctly calculates South offset (negative deltaYNM, bearing 180°)', () => {
      const targetLat = SFO_LAT - 0.1;
      const targetLon = SFO_LON;
      const offset = calculateGeographicOffset(SFO_LAT, SFO_LON, targetLat, targetLon);

      expect(offset.deltaYNM).toBeCloseTo(-6.0, 1);
      expect(offset.deltaXNM).toBeCloseTo(0.0, 1);
      expect(offset.distanceNM).toBeCloseTo(6.0, 1);
      expect(offset.bearingDeg).toBeCloseTo(180, 0);
    });

    it('correctly calculates East offset (positive deltaXNM, bearing 90°)', () => {
      // 0.1 degree East
      const targetLat = SFO_LAT;
      const targetLon = SFO_LON + 0.1;
      const offset = calculateGeographicOffset(SFO_LAT, SFO_LON, targetLat, targetLon);

      expect(offset.deltaYNM).toBeCloseTo(0.0, 1);
      expect(offset.deltaXNM).toBeGreaterThan(0);
      expect(offset.bearingDeg).toBeCloseTo(90, 0);
    });

    it('correctly calculates West offset (negative deltaXNM, bearing 270°)', () => {
      const targetLat = SFO_LAT;
      const targetLon = SFO_LON - 0.1;
      const offset = calculateGeographicOffset(SFO_LAT, SFO_LON, targetLat, targetLon);

      expect(offset.deltaYNM).toBeCloseTo(0.0, 1);
      expect(offset.deltaXNM).toBeLessThan(0);
      expect(offset.bearingDeg).toBeCloseTo(270, 0);
    });

    it('projects radar canvas coordinates with North as -Y and East as +X', () => {
      const rangeNM = 25;
      const maxRadiusPx = 250;

      // Target 10 NM North, 10 NM East
      const latNorth = SFO_LAT + 10 / 60;
      const lonEast = SFO_LON + 10 / (60 * Math.cos((SFO_LAT * Math.PI) / 180));

      const pos = calculateRadarCanvasPosition(
        SFO_LAT,
        SFO_LON,
        latNorth,
        lonEast,
        rangeNM,
        maxRadiusPx
      );

      expect(pos.inRange).toBe(true);
      expect(pos.x).toBeGreaterThan(0); // East is positive
      expect(pos.y).toBeLessThan(0); // North is negative in canvas Y
      expect(pos.distanceNM).toBeCloseTo(14.1, 1);
    });

    it('identifies targets outside configured nautical mile range', () => {
      const rangeNM = 25;
      const maxRadiusPx = 250;

      // Target 35 NM North (beyond 25 NM)
      const latNorth = SFO_LAT + 35 / 60;
      const pos = calculateRadarCanvasPosition(
        SFO_LAT,
        SFO_LON,
        latNorth,
        SFO_LON,
        rangeNM,
        maxRadiusPx
      );

      expect(pos.inRange).toBe(false);
      expect(pos.distanceNM).toBeCloseTo(35.0, 1);
    });

    it('handles radar center coordinates without division by zero', () => {
      const pos = calculateRadarCanvasPosition(
        SFO_LAT,
        SFO_LON,
        SFO_LAT,
        SFO_LON,
        25,
        250
      );

      expect(pos.inRange).toBe(true);
      expect(pos.x).toBe(0);
      expect(pos.y).toBe(0);
      expect(pos.distanceNM).toBe(0);
      expect(pos.bearingDeg).toBe(0);
    });
  });

  describe('2. ADS-B Raw Payload Normalization & Validation', () => {
    it('normalizes a complete real aircraft record', () => {
      const raw = {
        hex: 'a1cf6b',
        type: 'adsb_icao',
        flight: 'JBU1734 ',
        r: 'N2157J',
        t: 'A21N',
        desc: 'AIRBUS A-321neo',
        ownOp: 'JETBLUE AIRWAYS CORP',
        alt_baro: 3300,
        alt_geom: 3400,
        gs: 185.4,
        track: 115.3,
        baro_rate: -640,
        squawk: '3346',
        emergency: 'none',
        category: 'A3',
        lat: 37.611252,
        lon: -122.386680,
        seen_pos: 2.5,
      };

      const ac = normalizeAdsbAircraft(raw, SFO_LAT, SFO_LON, ISO_TIME);
      expect(ac).not.toBeNull();
      expect(ac!.hex).toBe('A1CF6B');
      expect(ac!.callsign).toBe('JBU1734');
      expect(ac!.hasCallsign).toBe(true);
      expect(ac!.registration).toBe('N2157J');
      expect(ac!.aircraftType).toBe('A21N');
      expect(ac!.aircraftDesc).toBe('AIRBUS A-321neo');
      expect(ac!.operator).toBe('JETBLUE AIRWAYS CORP');
      expect(ac!.altBaro).toBe(3300);
      expect(ac!.altGeom).toBe(3400);
      expect(ac!.groundSpeed).toBe(185.4);
      expect(ac!.track).toBe(115);
      expect(ac!.verticalRate).toBe(-640);
      expect(ac!.squawk).toBe('3346');
      expect(ac!.emergency).toBeNull(); // 'none' maps to null
      expect(ac!.category).toBe('A3');
      expect(ac!.seenPos).toBe(2.5);
    });

    it('handles ground aircraft (alt_baro = "ground")', () => {
      const raw = {
        hex: 'c060c9',
        flight: 'POE672',
        alt_baro: 'ground',
        gs: 0.0,
        lat: 37.6138,
        lon: -122.3864,
      };

      const ac = normalizeAdsbAircraft(raw, SFO_LAT, SFO_LON, ISO_TIME);
      expect(ac).not.toBeNull();
      expect(ac!.altBaro).toBe('ground');
    });

    it('provides fallback callsign when flight string is missing', () => {
      const raw = {
        hex: 'a55bcd',
        flight: '',
        alt_baro: 5000,
        lat: 37.65,
        lon: -122.35,
      };

      const ac = normalizeAdsbAircraft(raw, SFO_LAT, SFO_LON, ISO_TIME);
      expect(ac).not.toBeNull();
      expect(ac!.hasCallsign).toBe(false);
      expect(ac!.callsign).toBe('HEX:A55BCD');
    });

    it('handles missing altitude, track, speed, and squawk safely without fabricating values', () => {
      const raw = {
        hex: 'a99999',
        lat: 37.65,
        lon: -122.35,
      };

      const ac = normalizeAdsbAircraft(raw, SFO_LAT, SFO_LON, ISO_TIME);
      expect(ac).not.toBeNull();
      expect(ac!.altBaro).toBeNull();
      expect(ac!.altGeom).toBeNull();
      expect(ac!.groundSpeed).toBeNull();
      expect(ac!.track).toBeNull();
      expect(ac!.verticalRate).toBeNull();
      expect(ac!.squawk).toBeNull();
      expect(ac!.registration).toBeNull();
      expect(ac!.aircraftType).toBeNull();
    });

    it('rejects targets with missing or invalid coordinates', () => {
      expect(normalizeAdsbAircraft({ hex: 'abc123' }, SFO_LAT, SFO_LON, ISO_TIME)).toBeNull();
      expect(normalizeAdsbAircraft({ hex: 'abc123', lat: 'invalid', lon: -122 }, SFO_LAT, SFO_LON, ISO_TIME)).toBeNull();
      expect(normalizeAdsbAircraft({ hex: 'abc123', lat: 95, lon: -122 }, SFO_LAT, SFO_LON, ISO_TIME)).toBeNull();
      expect(normalizeAdsbAircraft({ hex: 'abc123', lat: 37, lon: 200 }, SFO_LAT, SFO_LON, ISO_TIME)).toBeNull();
    });

    it('rejects targets with missing or invalid hex identifiers', () => {
      expect(normalizeAdsbAircraft({ lat: 37.6, lon: -122.3 }, SFO_LAT, SFO_LON, ISO_TIME)).toBeNull();
      expect(normalizeAdsbAircraft({ hex: '', lat: 37.6, lon: -122.3 }, SFO_LAT, SFO_LON, ISO_TIME)).toBeNull();
      expect(normalizeAdsbAircraft({ hex: '123456789', lat: 37.6, lon: -122.3 }, SFO_LAT, SFO_LON, ISO_TIME)).toBeNull();
    });
  });

  describe('3. Deduplication & Batch Processing', () => {
    it('deduplicates multiple aircraft records with identical ICAO hex', () => {
      const payload = {
        ac: [
          { hex: 'A1B2C3', flight: 'UAL101', lat: 37.6, lon: -122.3, seen_pos: 5.2 },
          { hex: 'A1B2C3', flight: 'UAL101', lat: 37.61, lon: -122.31, seen_pos: 1.1 }, // Newer position
          { hex: 'D4E5F6', flight: 'SWA440', lat: 37.7, lon: -122.4, seen_pos: 2.0 },
        ],
        total: 3,
        now: 1729283940,
      };

      const result = processRawAircraftPayload(payload, SFO_LAT, SFO_LON, ISO_TIME);
      expect(result.aircraft.length).toBe(2);
      expect(result.aircraft.map((a) => a.hex).sort()).toEqual(['A1B2C3', 'D4E5F6']);

      const ual = result.aircraft.find((a) => a.hex === 'A1B2C3');
      expect(ual?.seenPos).toBe(1.1);
      expect(ual?.lat).toBe(37.61);
    });

    it('handles empty response gracefully', () => {
      const result = processRawAircraftPayload({ ac: [], total: 0 }, SFO_LAT, SFO_LON, ISO_TIME);
      expect(result.aircraft.length).toBe(0);
      expect(result.totalReported).toBe(0);
    });

    it('handles null or malformed response gracefully', () => {
      const result = processRawAircraftPayload(null, SFO_LAT, SFO_LON, ISO_TIME);
      expect(result.aircraft.length).toBe(0);
      expect(result.totalReported).toBe(0);
    });
  });

  describe('4. Configured Radar Centers', () => {
    it('defines KSFO as the default configured radar center', () => {
      const ksfo = RADAR_CENTERS.find((c) => c.id === 'KSFO');
      expect(ksfo).toBeDefined();
      expect(ksfo!.lat).toBeCloseTo(37.6213, 3);
      expect(ksfo!.lon).toBeCloseTo(-122.3790, 3);
    });

    it('provides secondary global radar centers', () => {
      expect(RADAR_CENTERS.map((c) => c.id)).toContain('EGLL');
      expect(RADAR_CENTERS.map((c) => c.id)).toContain('KJFK');
    });
  });
});
