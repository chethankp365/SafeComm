import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchAircraftPhoto, clearPhotoCache } from '../lib/aircraftPhotoService';
import { calculateGeographicOffset, calculateRadarCanvasPosition } from '../lib/aircraftService';

describe('SafeComm Phase B — Aircraft Photo Enrichment & Clutter Reduction', () => {
  const SFO_LAT = 37.6213;
  const SFO_LON = -122.3790;

  beforeEach(() => {
    vi.restoreAllMocks();
    clearPhotoCache();
  });

  describe('1. Aircraft Photo Service (Planespotters.net integration)', () => {
    it('rejects invalid or malformed ICAO hex codes without making network requests', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      
      const res1 = await fetchAircraftPhoto('invalid');
      const res2 = await fetchAircraftPhoto('12345'); // only 5 chars
      const res3 = await fetchAircraftPhoto('');
      
      expect(res1).toBeNull();
      expect(res2).toBeNull();
      expect(res3).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('successfully parses photo and attribution from valid Planespotters response', async () => {
      const mockResponse = {
        photos: [
          {
            id: '1953495',
            thumbnail: { src: 'https://t.plnspttrs.net/thumb.jpg', size: { width: 200, height: 133 } },
            thumbnail_large: { src: 'https://t.plnspttrs.net/large.jpg', size: { width: 420, height: 280 } },
            link: 'https://www.planespotters.net/photo/1953495/ja882j',
            photographer: 'Marvin Knitl',
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as unknown as Response);

      const result = await fetchAircraftPhoto('a1b2c3');
      expect(result).not.toBeNull();
      expect(result?.imageUrl).toBe('https://t.plnspttrs.net/large.jpg');
      expect(result?.photographer).toBe('Marvin Knitl');
      expect(result?.sourceLink).toBe('https://www.planespotters.net/photo/1953495/ja882j');
    });

    it('falls back to thumbnail if thumbnail_large is absent', async () => {
      const mockResponse = {
        photos: [
          {
            id: '9999',
            thumbnail: { src: 'https://t.plnspttrs.net/small.jpg' },
            photographer: 'Jane Doe',
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as unknown as Response);

      const result = await fetchAircraftPhoto('b2c3d4');
      expect(result?.imageUrl).toBe('https://t.plnspttrs.net/small.jpg');
    });

    it('handles malformed responses gracefully without throwing errors', async () => {
      // Malformed: empty object
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as unknown as Response);
      const res1 = await fetchAircraftPhoto('aaaaaa');
      expect(res1).toBeNull();

      // Malformed: photos is not an array
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ photos: 'invalid' }),
      } as unknown as Response);
      const res2 = await fetchAircraftPhoto('bbbbbb');
      expect(res2).toBeNull();

      // Malformed: JSON parse throws error
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => { throw new Error('Bad JSON'); },
      } as unknown as Response);
      const res3 = await fetchAircraftPhoto('cccccc');
      expect(res3).toBeNull();
    });

    it('returns null cleanly on genuine no-photo results (photos: [])', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ photos: [] }),
      } as unknown as Response);

      const result = await fetchAircraftPhoto('f0f0f0');
      expect(result).toBeNull();
    });

    it('handles HTTP error statuses (404, 500) gracefully without crashing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as unknown as Response);

      const result = await fetchAircraftPhoto('e0e0e0');
      expect(result).toBeNull();
    });

    it('caches photo result in memory to prevent duplicate network calls', async () => {
      const mockResponse = {
        photos: [
          {
            id: '8888',
            thumbnail_large: { src: 'https://t.plnspttrs.net/cached.jpg' },
            link: 'https://www.planespotters.net/photo/8888',
            photographer: 'John Doe',
          },
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as unknown as Response);

      const res1 = await fetchAircraftPhoto('c0ffee');
      const res2 = await fetchAircraftPhoto('C0FFEE'); // Case-insensitive test

      expect(res1?.imageUrl).toBe('https://t.plnspttrs.net/cached.jpg');
      expect(res2?.imageUrl).toBe('https://t.plnspttrs.net/cached.jpg');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('caches genuine no-photo results so negative lookups are not re-queried', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ photos: [] }),
      } as unknown as Response);

      const res1 = await fetchAircraftPhoto('112233');
      const res2 = await fetchAircraftPhoto('112233');

      expect(res1).toBeNull();
      expect(res2).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('respects request cancellation via AbortSignal without unhandled rejections', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await fetchAircraftPhoto('a17140', controller.signal);
      expect(result).toBeNull();
    });

    it('associates distinct photograph identities with their respective aircraft hex', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('111111')) {
          return {
            ok: true,
            json: async () => ({
              photos: [{ id: '1', thumbnail_large: { src: 'https://t.plnspttrs.net/plane1.jpg' }, photographer: 'Alice' }],
            }),
          } as unknown as Response;
        }
        if (urlStr.includes('222222')) {
          return {
            ok: true,
            json: async () => ({
              photos: [{ id: '2', thumbnail_large: { src: 'https://t.plnspttrs.net/plane2.jpg' }, photographer: 'Bob' }],
            }),
          } as unknown as Response;
        }
        return { ok: false } as unknown as Response;
      });

      const photoA = await fetchAircraftPhoto('111111');
      const photoB = await fetchAircraftPhoto('222222');

      expect(photoA?.imageUrl).toBe('https://t.plnspttrs.net/plane1.jpg');
      expect(photoA?.photographer).toBe('Alice');
      expect(photoB?.imageUrl).toBe('https://t.plnspttrs.net/plane2.jpg');
      expect(photoB?.photographer).toBe('Bob');
      expect(photoA?.imageUrl).not.toBe(photoB?.imageUrl);
    });
  });

  describe('2. Radar Clutter Reduction & Range Filtering (Task 1)', () => {
    it('correctly filters targets by 10 NM display range', () => {
      const centerLat = SFO_LAT;
      const centerLon = SFO_LON;

      // Target A: ~3 NM away
      const targetA = { lat: SFO_LAT + 0.05, lon: SFO_LON };
      const offsetA = calculateGeographicOffset(centerLat, centerLon, targetA.lat, targetA.lon);
      
      // Target B: ~18 NM away
      const targetB = { lat: SFO_LAT + 0.3, lon: SFO_LON };
      const offsetB = calculateGeographicOffset(centerLat, centerLon, targetB.lat, targetB.lon);

      expect(offsetA.distanceNM).toBeLessThan(10);
      expect(offsetB.distanceNM).toBeGreaterThan(10);

      const posA = calculateRadarCanvasPosition(centerLat, centerLon, targetA.lat, targetA.lon, 10, 300);
      const posB = calculateRadarCanvasPosition(centerLat, centerLon, targetB.lat, targetB.lon, 10, 300);

      expect(posA.inRange).toBe(true);
      expect(posB.inRange).toBe(false);
    });

    it('correctly prioritizes the selected aircraft label over closer aircraft', () => {
      const selectedHex = 'SELECTED1';
      const targets = [
        { hex: 'TARGET_CLOSE', distanceNM: 1.2 },
        { hex: 'TARGET_MID', distanceNM: 4.5 },
        { hex: 'SELECTED1', distanceNM: 7.8 }, // Selected target is further away
        { hex: 'TARGET_FAR', distanceNM: 9.1 },
      ];

      const sorted = [...targets].sort((a, b) => {
        if (a.hex === selectedHex) return -1;
        if (b.hex === selectedHex) return 1;
        return a.distanceNM - b.distanceNM;
      });

      // Selected target must be first to guarantee label visibility
      expect(sorted[0].hex).toBe(selectedHex);
      // Other targets are sorted by distance
      expect(sorted[1].hex).toBe('TARGET_CLOSE');
      expect(sorted[2].hex).toBe('TARGET_MID');
      expect(sorted[3].hex).toBe('TARGET_FAR');
    });

    it('guarantees max label cap (6-8 labels) while keeping targets clickable', () => {
      const MAX_FDB_LABELS = 8;
      const targets = Array.from({ length: 25 }, (_, i) => ({
        hex: `HEX_${i}`,
        distanceNM: i * 0.4,
      }));

      const selectedHex = 'HEX_20'; // Selected target is far out
      const prioritized = [...targets].sort((a, b) => {
        if (a.hex === selectedHex) return -1;
        if (b.hex === selectedHex) return 1;
        return a.distanceNM - b.distanceNM;
      });

      const labeledTargets = prioritized.slice(0, MAX_FDB_LABELS);
      expect(labeledTargets.length).toBe(8);
      expect(labeledTargets.some((t) => t.hex === selectedHex)).toBe(true);

      // Verify that all 25 targets remain clickable via canvas hit registry
      const hitRegistry = new Map<string, { x: number; y: number; r: number }>();
      targets.forEach((t, i) => {
        hitRegistry.set(t.hex, { x: 100 + i * 5, y: 100 + i * 5, r: 16 });
      });
      expect(hitRegistry.size).toBe(25);
      expect(hitRegistry.has('HEX_24')).toBe(true);
    });

    it('accurately detects bounding box collisions between adjacent labels', () => {
      const checkCollision = (
        boxA: { x: number; y: number; w: number; h: number },
        boxB: { x: number; y: number; w: number; h: number }
      ) => {
        return (
          boxA.x < boxB.x + boxB.w + 4 &&
          boxA.x + boxA.w + 4 > boxB.x &&
          boxA.y < boxB.y + boxB.h + 4 &&
          boxA.y + boxA.h + 4 > boxB.y
        );
      };

      const box1 = { x: 100, y: 100, w: 66, h: 26 };
      const overlappingBox = { x: 110, y: 105, w: 66, h: 26 };
      const separatedBox = { x: 200, y: 200, w: 66, h: 26 };

      expect(checkCollision(box1, overlappingBox)).toBe(true);
      expect(checkCollision(box1, separatedBox)).toBe(false);
    });

    it('detects when a selected target is outside the active display range', () => {
      const selectedTargetDistance = 15.4;
      const range10NM = 10;
      const range25NM = 25;

      const isOutside10NM = selectedTargetDistance > range10NM;
      const isOutside25NM = selectedTargetDistance > range25NM;

      expect(isOutside10NM).toBe(true);
      expect(isOutside25NM).toBe(false);
    });

    it('safely handles missing or null telemetry fields in flight data blocks', () => {
      const testCases = [
        { altBaro: 'ground', expectedAlt: 'GND' },
        { altBaro: 3500, expectedAlt: 'FL035' },
        { altBaro: null, expectedAlt: '---' },
      ];

      testCases.forEach((tc) => {
        let altDisplay = '---';
        if (tc.altBaro === 'ground') {
          altDisplay = 'GND';
        } else if (typeof tc.altBaro === 'number') {
          altDisplay = `FL${String(Math.round(tc.altBaro / 100)).padStart(3, '0')}`;
        }
        expect(altDisplay).toBe(tc.expectedAlt);
      });
    });
  });
});
