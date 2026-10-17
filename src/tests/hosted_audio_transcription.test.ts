import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke },
  },
}));

import { transcribeHostedAudio } from '../lib/hostedAudioTranscription';

describe('hosted audio transcription client', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('sends a PTT audio recording and its room role to the protected transcription function', async () => {
    invoke.mockResolvedValue({
      data: { text: 'Speedbird 214 turn right heading 090', provider: 'groq' },
      error: null,
    });

    const text = await transcribeHostedAudio(
      new Blob(['audio-data'], { type: 'audio/webm;codecs=opus' }),
      'a17e75af-d87e-40a0-b489-e78421bb9991',
      'pilot'
    );

    expect(text).toBe('Speedbird 214 turn right heading 090');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('transcribe-audio', {
      body: expect.any(FormData),
    });
    const form = invoke.mock.calls[0]?.[1].body as FormData;
    expect(form.get('roomId')).toBe('a17e75af-d87e-40a0-b489-e78421bb9991');
    expect(form.get('role')).toBe('pilot');
    expect((form.get('audio') as File).name).toBe('transmission.webm');
  });

  it('reports provider errors and rejects empty recordings instead of returning success-shaped text', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: new Error('Function unavailable'),
    });

    await expect(transcribeHostedAudio(new Blob(), 'room-id', 'pilot'))
      .rejects.toThrow('recorded audio is empty');
    expect(invoke).not.toHaveBeenCalled();

    await expect(transcribeHostedAudio(new Blob(['audio']), 'room-id', 'pilot'))
      .rejects.toThrow('Function unavailable');
  });
});
