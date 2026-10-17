import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

type RoomRole = 'atc' | 'pilot';

export type RoomAuthorizationResult =
  | { authorized: true }
  | { authorized: false; status: number; error: string };

export async function authorizeRoomParticipant(
  request: Request,
  roomId: string,
  role: RoomRole,
): Promise<RoomAuthorizationResult> {
  const authorization = request.headers.get('Authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      authorized: false,
      status: 500,
      error: 'Authentication verification is not configured.',
    };
  }
  if (!authorization?.startsWith('Bearer ')) {
    return {
      authorized: false,
      status: 401,
      error: 'Sign in is required for this operation.',
    };
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const accessToken = authorization.replace(/^Bearer\s+/i, '');
  const { data: { user }, error: authError } = await userClient.auth.getUser(
    accessToken,
  );
  if (authError || !user) {
    return {
      authorized: false,
      status: 401,
      error: 'A valid signed-in user is required.',
    };
  }

  const { data: room, error: roomError } = await userClient
    .from('comm_rooms')
    .select('id, created_by, status')
    .eq('id', roomId)
    .maybeSingle();
  if (roomError) {
    return {
      authorized: false,
      status: 500,
      error: 'Unable to verify communication room access.',
    };
  }
  if (!room || room.status === 'completed' || room.status === 'abandoned') {
    return {
      authorized: false,
      status: 403,
      error: 'An active communication room is required.',
    };
  }

  const { data: participant, error: participantError } = await userClient
    .from('comm_participants')
    .select('role, status')
    .eq('room_id', roomId)
    .eq('user_id', user.id)
    .neq('status', 'left')
    .maybeSingle();
  if (participantError) {
    return {
      authorized: false,
      status: 500,
      error: 'Unable to verify room participant access.',
    };
  }

  const assignedRole = participant?.role ||
    (room.created_by === user.id ? 'atc' : null);
  if (assignedRole !== role) {
    return {
      authorized: false,
      status: 403,
      error: 'The signed-in user is not authorized for this room role.',
    };
  }

  return { authorized: true };
}
