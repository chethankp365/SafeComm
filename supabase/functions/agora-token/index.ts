// Supabase Edge Function: agora-token
// Deno runtime: generates short-lived Agora RTC tokens with strict Supabase authorization

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { RtcTokenBuilder, RtcRole } from 'npm:agora-token';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Stable 32-bit unsigned integer UID generator with optional per-tab clientNonce
function deriveNumericUid(userId: string, role: string, clientNonce: string = ''): number {
  let hash = 0;
  const seed = `${userId}:${role}:${clientNonce}`;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 2000000000) + 10000;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Validate Supabase User Authorization
    const authHeader = req.headers.get('Authorization');
    const accessToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'Authorization header required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(JSON.stringify({ error: 'Supabase server authorization configuration is incomplete' }), {
        status: 503,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Room lookups use the caller's JWT; RLS allows reads only to creators and participants.
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired user session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. Parse and Validate Request Payload
    const body = await req.json().catch(() => ({}));
    const rawRoomId = body?.roomId;
    const clientNonce = typeof body?.clientNonce === 'string' ? body.clientNonce.slice(0, 16) : '';

    if (!rawRoomId || typeof rawRoomId !== 'string') {
      return new Response(JSON.stringify({ error: 'Valid roomId required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Resolve Authoritative Canonical Room UUID
    let canonicalRoomId = rawRoomId;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawRoomId);

    if (!isUuid) {
      const { data: roomByCode, error: roomCodeError } = await userClient
        .from('comm_rooms')
        .select('id')
        .ilike('join_code', rawRoomId)
        .maybeSingle();

      if (roomCodeError) {
        console.error('[agora-token] Room-code lookup failed:', roomCodeError);
        return new Response(JSON.stringify({ error: 'Unable to verify communication room' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!roomByCode?.id) {
        return new Response(JSON.stringify({ error: 'Communication room not found for join code' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      canonicalRoomId = roomByCode.id;
    }

    // 4. Verify Room State
    const { data: room, error: roomError } = await userClient
      .from('comm_rooms')
      .select('id, status, created_by')
      .eq('id', canonicalRoomId)
      .maybeSingle();

    if (roomError) {
      console.error('[agora-token] Room authorization lookup failed:', roomError);
      return new Response(JSON.stringify({ error: 'Unable to verify communication room' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!room) {
      return new Response(JSON.stringify({ error: 'Communication room not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (room.status === 'completed' || room.status === 'abandoned') {
      return new Response(JSON.stringify({ error: `Communication room is ${room.status}` }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 5. Verify User Membership & Retrieve Locked Role
    const { data: participant, error: participantError } = await userClient
      .from('comm_participants')
      .select('id, role, status')
      .eq('room_id', canonicalRoomId)
      .eq('user_id', user.id)
      .neq('status', 'left')
      .maybeSingle();

    if (participantError) {
      console.error('[agora-token] Participant authorization lookup failed:', participantError);
      return new Response(JSON.stringify({ error: 'Unable to verify room participant' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let assignedRole: 'atc' | 'pilot' | null = participant?.role as 'atc' | 'pilot' | null;

    if (!assignedRole) {
      // If room creator hasn't finished participant insert, fallback to creator ATC role
      if (room.created_by === user.id) {
        assignedRole = 'atc';
      } else {
        return new Response(JSON.stringify({ error: 'User is not an authorized participant in this room' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // 6. Read Agora Server Secrets (Strictly Server-Side)
    const agoraAppId = Deno.env.get('AGORA_APP_ID');
    const agoraAppCertificate = Deno.env.get('AGORA_APP_CERTIFICATE');

    if (!agoraAppId || !agoraAppCertificate) {
      return new Response(
        JSON.stringify({
          error: 'Agora credentials unconfigured in server secrets (AGORA_APP_ID / AGORA_APP_CERTIFICATE)',
        }),
        {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // 7. Generate Numeric UID and AccessToken2
    const uid = deriveNumericUid(user.id, assignedRole, clientNonce);
    const expirationTimeInSeconds = 3600; // 1 hour token validity
    const privilegeExpiredTs = 3600;

    const token = RtcTokenBuilder.buildTokenWithUid(
      agoraAppId,
      agoraAppCertificate,
      canonicalRoomId,
      uid,
      RtcRole.PUBLISHER,
      expirationTimeInSeconds,
      privilegeExpiredTs
    );

    const expiresAt = Date.now() + expirationTimeInSeconds * 1000;

    // 8. Return Only Client-Required Minimal Metadata (Never App Certificate)
    return new Response(
      JSON.stringify({
        appId: agoraAppId,
        channel: canonicalRoomId,
        uid,
        token,
        role: assignedRole,
        expiresAt,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (err: unknown) {
    console.error('[agora-token] Token generation failed:', err);
    return new Response(JSON.stringify({ error: 'Unable to generate Agora token; check the Edge Function logs' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
