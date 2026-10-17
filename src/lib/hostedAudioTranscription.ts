import type { CommRole } from './commRooms';
import { supabase } from './supabase';

const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024;

export async function transcribeHostedAudio(
  audio: Blob,
  roomId: string,
  role: CommRole
): Promise<string> {
  if (!audio.size) throw new Error('The recorded audio is empty.');
  if (audio.size > MAX_AUDIO_SIZE_BYTES) throw new Error('The recorded audio exceeds the 5 MB limit.');

  const extension = audio.type.includes('ogg') ? 'ogg'
    : audio.type.includes('mp4') ? 'mp4'
      : audio.type.includes('wav') ? 'wav'
        : audio.type.includes('mpeg') || audio.type.includes('mp3') ? 'mp3'
          : 'webm';
  const form = new FormData();
  form.set('audio', audio, `transmission.${extension}`);
  form.set('roomId', roomId);
  form.set('role', role);

  const { data, error } = await supabase.functions.invoke('transcribe-audio', { body: form });
  if (error) throw new Error(`Hosted speech transcription failed: ${error.message}`);
  if (!data || typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error('Hosted speech recognizer returned an invalid transcript.');
  }
  return data.text.trim();
}
