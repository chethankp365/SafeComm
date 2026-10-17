/**
 * SafeComm — Aviation Audio Earcon & Notification Synthesizer
 * 
 * Uses Web Audio API to synthesize authentic cockpit caution/warning chimes
 * without external audio file dependencies.
 */

const NOTIFICATION_SOUND_KEY = 'safecomm_notification_sound';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Check if alert notification sound is enabled
 */
export function isNotificationSoundEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true;
  const val = localStorage.getItem(NOTIFICATION_SOUND_KEY);
  return val === null ? true : val === 'true';
}

/**
 * Persist alert notification sound setting
 */
export function setNotificationSoundEnabled(enabled: boolean): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(NOTIFICATION_SOUND_KEY, String(enabled));
  }
}

/**
 * Synthesizes an authentic aviation Master Caution / Alert two-tone earcon
 * Tone 1: 880 Hz (A5), Tone 2: 1320 Hz (E6), Tone 3: 1760 Hz (A6)
 */
export function playHighAlertEarcon(): void {
  if (!isNotificationSoundEnabled()) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    // Dual-tone chime
    const tones = [
      { freq: 880, start: 0, duration: 0.12 },
      { freq: 1760, start: 0.14, duration: 0.22 },
    ];

    tones.forEach(({ freq, start, duration }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + start);

      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.25, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + start + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + start);
      osc.stop(now + start + duration);
    });
  } catch (err) {
    console.warn('[SafeComm Audio] Failed to play earcon chime:', err);
  }
}
