import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// In-memory cache for rate-limit protection (minimum 3s between upstream requests)
interface CachedData {
  timestamp: number;
  data: unknown;
}
const cache = new Map<string, CachedData>();
const CACHE_TTL_MS = 5000; // 5-second cache prevents hammering upstream rate limit

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const queryHex = url.searchParams.get('hex');
    const queryReg = url.searchParams.get('reg');

    // Handle Aircraft Photo Proxy
    if (action === 'photo' || (queryHex && !url.searchParams.has('lat')) || (queryReg && !url.searchParams.has('lat'))) {
      const targetHex = (queryHex || '').trim().toLowerCase();
      const targetReg = (queryReg || '').trim().toUpperCase();

      if (!targetHex && !targetReg) {
        return new Response(JSON.stringify({ error: 'Valid ICAO hex or registration required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const photoCacheKey = `photo:${targetHex || targetReg}`;
      const now = Date.now();
      const cached = cache.get(photoCacheKey);
      if (cached && now - cached.timestamp < 3600000) {
        return new Response(JSON.stringify(cached.data), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
      }

      try {
        const endpoint = targetHex
          ? `https://api.planespotters.net/pub/photos/hex/${targetHex}`
          : `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(targetReg)}`;

        const upstreamRes = await fetch(endpoint, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'SafeCommAviation/1.0 (+https://safecomm.app; contact@safecomm.app)',
          },
        });

        let payload = upstreamRes.ok ? await upstreamRes.json().catch(() => ({})) : { photos: [] };

        // Fallback to registration if hex returned 0 photos and reg is present
        if ((!payload.photos || payload.photos.length === 0) && targetReg && targetHex) {
          const regRes = await fetch(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(targetReg)}`, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'SafeCommAviation/1.0 (+https://safecomm.app; contact@safecomm.app)',
            },
          }).catch(() => null);

          if (regRes && regRes.ok) {
            const regPayload = await regRes.json().catch(() => ({}));
            if (regPayload.photos && regPayload.photos.length > 0) {
              payload = regPayload;
            }
          }
        }

        cache.set(photoCacheKey, { timestamp: now, data: payload });
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch {
        return new Response(JSON.stringify({ photos: [] }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    let lat: number;
    let lon: number;
    let dist: number;

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      lat = parseFloat(body.lat);
      lon = parseFloat(body.lon);
      dist = parseInt(body.dist, 10) || 25;
    } else {
      lat = parseFloat(url.searchParams.get('lat') || '');
      lon = parseFloat(url.searchParams.get('lon') || '');
      dist = parseInt(url.searchParams.get('dist') || '25', 10);
    }

    // Coordinate validation
    if (isNaN(lat) || lat < -90 || lat > 90) {
      return new Response(
        JSON.stringify({ error: 'Invalid latitude parameter. Must be between -90 and 90.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (isNaN(lon) || lon < -180 || lon > 180) {
      return new Response(
        JSON.stringify({ error: 'Invalid longitude parameter. Must be between -180 and 180.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (isNaN(dist) || dist < 1 || dist > 100) {
      dist = 25;
    }

    const cacheKey = `${lat.toFixed(3)}:${lon.toFixed(3)}:${dist}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);

    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return new Response(JSON.stringify(cached.data), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'X-Cache': 'HIT',
        },
      });
    }

    // Upstream request to adsb.fi
    const upstreamUrl = `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const upstreamRes = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SafeComm-Aerospace-Surveillance/1.0',
      },
    });
    clearTimeout(timeoutId);

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      return new Response(
        JSON.stringify({
          error: `Upstream ADS-B provider returned HTTP ${upstreamRes.status}`,
          details: errText,
        }),
        {
          status: upstreamRes.status === 429 ? 429 : 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const payload = await upstreamRes.json();
    cache.set(cacheKey, { timestamp: now, data: payload });

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'X-Cache': 'MISS',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown live aircraft proxy error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
