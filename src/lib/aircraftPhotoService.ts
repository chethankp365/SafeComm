/**
 * SafeComm — Aircraft Photo Enrichment Service
 * 
 * Fetches authentic, registration/ICAO-matched aircraft photographs from Planespotters.net
 * via the configured dev proxy or Supabase Edge Function, ensuring full photographer
 * attribution and avoiding duplicate requests or stale overwrites.
 */

export interface AircraftPhotoData {
  imageUrl: string | null;
  thumbnailUrl: string | null;
  photographer: string | null;
  sourceLink: string | null;
  format?: string;
}

// In-memory cache of photo results keyed by lowercase ICAO hex or uppercase registration
const photoCache = new Map<string, AircraftPhotoData | null>();

/**
 * Clear photo cache (primarily for automated testing)
 */
export function clearPhotoCache(): void {
  photoCache.clear();
}

/**
 * Fetch aircraft photograph for a specific ICAO 24-bit hex identifier,
 * with optional registration fallback.
 * Returns null if no photo is available or if request fails.
 */
export async function fetchAircraftPhoto(
  hex: string,
  registrationOrSignal?: string | null | AbortSignal,
  optionalSignal?: AbortSignal
): Promise<AircraftPhotoData | null> {
  let registration: string | null = null;
  let signal: AbortSignal | undefined = optionalSignal;

  if (registrationOrSignal instanceof AbortSignal) {
    signal = registrationOrSignal;
  } else if (typeof registrationOrSignal === 'string') {
    registration = registrationOrSignal.trim().toUpperCase() || null;
  }

  const normalizedHex = (hex || '').trim().toLowerCase();
  const isValidHex = /^[0-9a-f]{6}$/i.test(normalizedHex);

  if (!isValidHex && !registration) {
    return null;
  }

  const cacheKey = isValidHex ? normalizedHex : `reg:${registration}`;

  // Return cached result if already fetched during this session
  if (photoCache.has(cacheKey)) {
    return photoCache.get(cacheKey) || null;
  }

  const parsePhotoPayload = (json: any): AircraftPhotoData | null => {
    if (json && Array.isArray(json.photos) && json.photos.length > 0) {
      const p = json.photos[0];
      const img = p.thumbnail_large?.src || p.thumbnail?.src || null;
      if (img) {
        return {
          imageUrl: img,
          thumbnailUrl: p.thumbnail?.src || null,
          photographer: p.photographer || 'Planespotters.net Contributor',
          sourceLink: p.link || (p.id ? `https://www.planespotters.net/photo/${p.id}` : null),
        };
      }
    }
    return null;
  };

  let definitiveNoPhoto = false;

  const tryFetch = async (url: string): Promise<AircraftPhotoData | null> => {
    const res = await fetch(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    if (json && Array.isArray(json.photos)) {
      if (json.photos.length === 0) {
        definitiveNoPhoto = true;
        return null;
      }
      return parsePhotoPayload(json);
    }
    return null;
  };

  try {
    let result: AircraftPhotoData | null = null;

    // 1. Try local Vite dev proxy
    if (isValidHex) {
      try {
        result = await tryFetch(`/api/planespotters/hex/${normalizedHex}`);
      } catch {
        // Dev proxy network failure; will try edge function
      }
    }

    // 2. If hex had no photo, try registration via local proxy if available
    if (!result && registration && !signal?.aborted) {
      try {
        result = await tryFetch(`/api/planespotters/reg/${encodeURIComponent(registration)}`);
      } catch {
        // Dev proxy network failure
      }
    }

    // 3. Fallback to deployed Supabase Edge Function ONLY if dev proxy failed to connect (not on definitive no-photo)
    if (!result && !definitiveNoPhoto && !signal?.aborted) {
      try {
        const edgeUrl = 'https://sduigyfousbbhrgkjjjg.supabase.co/functions/v1/live-aircraft';
        const params = new URLSearchParams({ action: 'photo' });
        if (isValidHex) params.set('hex', normalizedHex);
        if (registration) params.set('reg', registration);

        result = await tryFetch(`${edgeUrl}?${params.toString()}`);
      } catch {
        // Network or edge function failure
      }
    }

    photoCache.set(cacheKey, result);
    return result;
  } catch (err) {
    if (signal?.aborted) return null;
    photoCache.set(cacheKey, null);
    return null;
  }
}
