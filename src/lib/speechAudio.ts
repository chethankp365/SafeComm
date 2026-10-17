// SafeComm Web Speech & Aviation Radio Audio Synthesizer
// Browser-native SpeechSynthesis and Web Audio API synthesizer for realistic simulated ATC training audio

export type SpeakerRole = 'controller' | 'pilot' | 'assistant';

export interface VoiceSettings {
  enabled: boolean;
  muted: boolean;
  rate: number; // 0.8 - 1.4
  volume: number; // 0 - 1
  controllerVoiceName?: string;
  pilotVoiceName?: string;
  assistantVoiceName?: string;
}

export function shouldSpeakSafeCommAlert(
  outcome: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED'
): boolean {
  return outcome === 'MISMATCH';
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  muted: false,
  rate: 1.05,
  volume: 0.9,
};

const VOICE_STORAGE_KEY = 'safecomm_voice_settings';

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

export function loadVoiceSettings(): VoiceSettings {
  const storage = getStorage();
  if (!storage) return DEFAULT_VOICE_SETTINGS;
  try {
    const saved = storage.getItem(VOICE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_VOICE_SETTINGS, ...parsed };
    }
  } catch {
    // Ignore storage errors
  }
  return DEFAULT_VOICE_SETTINGS;
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(VOICE_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors
  }
}

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Synthesizes realistic radio squelch mic clicks and aerospace alert chimes
 */
export function playRadioTone(type: 'mic_click' | 'alert_chime' | 'warning'): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    if (type === 'mic_click') {
      // Short realistic radio burst (35ms high pass click)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.04);

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.04);
    } else if (type === 'alert_chime' || type === 'warning') {
      // Dual-tone aviation Master Caution beep (880Hz + 1174Hz)
      const now = ctx.currentTime;
      [880, 1174].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.07);

        gain.gain.setValueAtTime(0.12, now + idx * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.12);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.07);
        osc.stop(now + idx * 0.07 + 0.13);
      });
    }
  } catch {
    // Ignore audio context autoplay restrictions
  }
}

export function isSpeechSynthesisSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

export function getAvailableVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!isSpeechSynthesisSupported()) return Promise.resolve([]);

  return new Promise((resolve) => {
    let voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      resolve(voices);
      return;
    }

    const handler = () => {
      voices = window.speechSynthesis.getVoices();
      window.speechSynthesis.removeEventListener('voiceschanged', handler);
      resolve(voices);
    };

    window.speechSynthesis.addEventListener('voiceschanged', handler);

    // Fallback if event never fires
    setTimeout(() => {
      resolve(window.speechSynthesis.getVoices());
    }, 400);
  });
}

/**
 * Subscribes to the voiceschanged event to reliably handle asynchronous voice loading
 */
export function onVoicesChanged(callback: (voices: SpeechSynthesisVoice[]) => void): () => void {
  if (!isSpeechSynthesisSupported()) return () => {};

  const handler = () => {
    const voices = window.speechSynthesis.getVoices();
    callback(voices);
  };

  window.speechSynthesis.addEventListener('voiceschanged', handler);

  // Initial populate if available
  const existingVoices = window.speechSynthesis.getVoices();
  if (existingVoices.length > 0) {
    callback(existingVoices);
  }

  return () => {
    window.speechSynthesis.removeEventListener('voiceschanged', handler);
  };
}

/**
 * Known Natural & Neural Female English Voices across Windows Edge, macOS, Safari, and Chrome
 */
export const FEMALE_ASSISTANT_VOICE_PATTERNS = [
  // Microsoft Edge Natural Online Female Voices (Highest clarity and naturalness)
  /Microsoft Jenny Online \(Natural\)/i,
  /Microsoft Aria Online \(Natural\)/i,
  /Microsoft Sonia Online \(Natural\)/i,
  /Microsoft Libby Online \(Natural\)/i,
  /Microsoft Michelle Online \(Natural\)/i,
  /Microsoft Ana Online \(Natural\)/i,
  /Microsoft Clara Online \(Natural\)/i,
  /Microsoft Natasha Online \(Natural\)/i,
  /Microsoft Neerja Online \(Natural\)/i,
  // Apple macOS / iOS Premium & Natural Female Voices
  /Samantha.*(?:Enhanced|Premium)/i,
  /Ava.*(?:Enhanced|Premium)/i,
  /Serena.*(?:Enhanced|Premium)/i,
  /Samantha/i,
  /Ava/i,
  /Serena/i,
  /Allison/i,
  /Susan/i,
  /Victoria/i,
  /Karen/i,
  /Moira/i,
  /Tessa/i,
  /Fiona/i,
  // Google / Chrome Natural Female Voices
  /Google US English/i,
  /Google UK English Female/i,
  // Windows SAPI Desktop Female Voices
  /Microsoft Zira Desktop/i,
  /Jenny/i,
  /Aria/i,
  /Zira/i,
];

/**
 * Controller Male / Authoritative ATC Voice Patterns
 */
export const MALE_CONTROLLER_VOICE_PATTERNS = [
  /David/i,
  /Microsoft Guy Online \(Natural\)/i,
  /Microsoft Christopher Online \(Natural\)/i,
  /Microsoft Eric Online \(Natural\)/i,
  /Microsoft Ryan Online \(Natural\)/i,
  /Guy/i,
  /Mark/i,
  /Daniel/i,
  /Oliver/i,
  /George/i,
  /Google UK English Male/i,
];

/**
 * Chooses distinct voices for ATC controller, pilot, and SafeComm safety assistant
 * Ensuring SafeComm assistant defaults to a professional, natural-sounding female English voice
 */
export function selectBestVoice(
  voices: SpeechSynthesisVoice[],
  role: SpeakerRole,
  customName?: string,
  assignedVoices: {
    controllerVoiceName?: string;
    assistantVoiceName?: string;
    pilotVoiceName?: string;
  } = {}
): { voice: SpeechSynthesisVoice | null; pitch: number; rateMultiplier: number } {
  if (voices.length === 0) {
    return {
      voice: null,
      pitch: role === 'pilot' ? 1.15 : role === 'assistant' ? 1.02 : 0.94,
      rateMultiplier: role === 'controller' ? 1.05 : role === 'assistant' ? 0.98 : 1.0,
    };
  }

  // 1. If a specific voice was explicitly selected by user
  if (customName) {
    const found = voices.find((v) => v.name === customName);
    if (found) {
      return {
        voice: found,
        pitch: role === 'pilot' ? 1.15 : role === 'assistant' ? 1.02 : 0.94,
        rateMultiplier: role === 'controller' ? 1.05 : role === 'assistant' ? 0.98 : 1.0,
      };
    }
  }

  // Filter for English voices (en-US, en-GB, en-AU, en-CA, etc.)
  const englishVoices = voices.filter((v) => v.lang.startsWith('en'));
  const candidatePool = englishVoices.length > 0 ? englishVoices : voices;

  let chosenVoice: SpeechSynthesisVoice | null = null;
  let pitch = 1.0;
  let rateMultiplier = 1.0;

  if (role === 'assistant') {
    // Professional, natural-sounding female English voice for SafeComm warnings & advisories
    // Priority: Tier 1 high-fidelity natural female voices (Jenny, Aria, Samantha, Zira, etc.)
    for (const pattern of FEMALE_ASSISTANT_VOICE_PATTERNS) {
      const match = candidatePool.find(
        (v) =>
          pattern.test(v.name) &&
          (!assignedVoices.controllerVoiceName || v.name !== assignedVoices.controllerVoiceName)
      );
      if (match) {
        chosenVoice = match;
        break;
      }
    }

    // Tier 2: Check for any voice explicitly tagged as female
    if (!chosenVoice) {
      chosenVoice =
        candidatePool.find(
          (v) =>
            /female|woman/i.test(v.name) &&
            (!assignedVoices.controllerVoiceName || v.name !== assignedVoices.controllerVoiceName)
        ) || null;
    }

    // Tier 3: Fallback to an English voice that is not the controller voice
    if (!chosenVoice) {
      chosenVoice =
        candidatePool.find(
          (v) =>
            !assignedVoices.controllerVoiceName || v.name !== assignedVoices.controllerVoiceName
        ) ||
        candidatePool[0] ||
        null;
    }

    pitch = 1.02; // Articulate, natural tone
    rateMultiplier = 0.98; // Measured aeronautical advisory pace
  } else if (role === 'controller') {
    // Look for deep, authoritative, professional ATC tone
    for (const pattern of MALE_CONTROLLER_VOICE_PATTERNS) {
      const match = candidatePool.find(
        (v) =>
          pattern.test(v.name) &&
          (!assignedVoices.assistantVoiceName || v.name !== assignedVoices.assistantVoiceName)
      );
      if (match) {
        chosenVoice = match;
        break;
      }
    }

    if (!chosenVoice) {
      chosenVoice =
        candidatePool.find(
          (v) =>
            !assignedVoices.assistantVoiceName || v.name !== assignedVoices.assistantVoiceName
        ) ||
        candidatePool[0] ||
        null;
    }

    pitch = 0.94; // Deep tower pitch
    rateMultiplier = 1.05; // Brisk ATC cadence
  } else {
    // Pilot: Flight crew cockpit cadence
    // Try to find a voice distinct from both controller and assistant
    chosenVoice =
      candidatePool.find(
        (v) =>
          (!assignedVoices.controllerVoiceName || v.name !== assignedVoices.controllerVoiceName) &&
          (!assignedVoices.assistantVoiceName || v.name !== assignedVoices.assistantVoiceName)
      ) ||
      candidatePool.find((v) => v !== chosenVoice) ||
      candidatePool[0] ||
      null;

    pitch = 1.14; // Higher distinct radio pitch
    rateMultiplier = 1.0;
  }

  return { voice: chosenVoice, pitch, rateMultiplier };
}

/**
 * Speaks a phrase using the browser SpeechSynthesis API with role-specific tone and pitch
 */
export function speakPhrase(
  text: string,
  role: SpeakerRole,
  settings: VoiceSettings,
  voices: SpeechSynthesisVoice[] = []
): Promise<void> {
  if (!isSpeechSynthesisSupported() || !settings.enabled || settings.muted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    try {
      // Cancel any ongoing stale utterances to prevent overlap
      window.speechSynthesis.cancel();

      // Play short radio chime
      if (role === 'assistant') {
        playRadioTone('alert_chime');
      } else {
        playRadioTone('mic_click');
      }

      const utterance = new SpeechSynthesisUtterance(text);
      const voiceConfig = selectBestVoice(
        voices,
        role,
        role === 'controller'
          ? settings.controllerVoiceName
          : role === 'pilot'
          ? settings.pilotVoiceName
          : settings.assistantVoiceName,
        {
          controllerVoiceName: settings.controllerVoiceName,
          assistantVoiceName: settings.assistantVoiceName,
          pilotVoiceName: settings.pilotVoiceName,
        }
      );

      if (voiceConfig.voice) {
        utterance.voice = voiceConfig.voice;
      }

      utterance.pitch = voiceConfig.pitch;
      utterance.rate = Math.max(0.7, Math.min(1.5, settings.rate * voiceConfig.rateMultiplier));
      utterance.volume = Math.max(0, Math.min(1, settings.volume));

      let hasFinished = false;

      const finish = () => {
        if (!hasFinished) {
          hasFinished = true;
          resolve();
        }
      };

      utterance.onend = finish;
      utterance.onerror = (event) => {
        if (event.error !== 'canceled' && event.error !== 'interrupted') {
          console.warn('[SafeComm SpeechAudio] Browser speech synthesis failed:', event.error);
        }
        finish();
      };

      // Safety timeout: Ensure scenario never hangs indefinitely if browser voice engine halts
      const estimatedDurationMs = Math.max(
        2500,
        (text.split(' ').length / (settings.rate * 2.5)) * 1000 + 1500
      );
      const timeoutId = setTimeout(finish, estimatedDurationMs);

      utterance.onend = () => {
        clearTimeout(timeoutId);
        finish();
      };

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('[SafeComm SpeechAudio] Speech synthesis failed gracefully:', err);
      resolve();
    }
  });
}

/**
 * Plays a representative test sample for the specified role
 */
export function previewVoice(
  voiceName: string | undefined,
  role: SpeakerRole,
  settings: VoiceSettings,
  voices: SpeechSynthesisVoice[] = []
): Promise<void> {
  if (!isSpeechSynthesisSupported()) return Promise.resolve();

  cancelAllSpeech();

  const previewTexts: Record<SpeakerRole, string> = {
    assistant: 'SafeComm Alert. Read-back deviation detected. Immediate heading correction required.',
    controller: 'San Francisco Tower, radar contact, climb and maintain flight level 100.',
    pilot: 'Climb and maintain flight level 100, Speedbird 214.',
  };

  const previewSettings: VoiceSettings = {
    ...settings,
    enabled: true,
    muted: false,
    [role === 'assistant'
      ? 'assistantVoiceName'
      : role === 'controller'
      ? 'controllerVoiceName'
      : 'pilotVoiceName']: voiceName,
  };

  return speakPhrase(previewTexts[role], role, previewSettings, voices);
}

export function stopVoicePreview(): void {
  cancelAllSpeech();
}

export function cancelAllSpeech(): void {
  if (isSpeechSynthesisSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

export function pauseSpeech(): void {
  if (isSpeechSynthesisSupported()) {
    try {
      window.speechSynthesis.pause();
    } catch {
      // ignore
    }
  }
}

export function resumeSpeech(): void {
  if (isSpeechSynthesisSupported()) {
    try {
      window.speechSynthesis.resume();
    } catch {
      // ignore
    }
  }
}

/**
 * Scripted spoken training corrections and verified read-back retries
 */
export interface ScenarioCorrectionData {
  hasCorrection: boolean;
  deviationTitle: string;
  spokenGuidance: string;
  scriptedCorrectedReadback: string;
  pilotCallsign: string;
}

export const SCENARIO_TRAINING_CORRECTIONS: Record<string, ScenarioCorrectionData> = {
  'scenario-correct-readback': {
    hasCorrection: false,
    deviationTitle: 'Nominal Read-back',
    spokenGuidance: '',
    scriptedCorrectedReadback: '',
    pilotCallsign: 'BAW214',
  },
  'scenario-heading-swap': {
    hasCorrection: true,
    deviationTitle: 'Critical Heading Direction Swap',
    spokenGuidance:
      'SafeComm Alert. Read-back deviation detected. Controller assigned turn right heading 090, but pilot read back turn left. Immediate heading correction required.',
    scriptedCorrectedReadback:
      'Correcting, turn right heading 090, maintain 3000 until established, United 421.',
    pilotCallsign: 'UAL421',
  },
  'scenario-runway-altitude-mismatch': {
    hasCorrection: true,
    deviationTitle: 'Runway Incursion Hazard & Altitude Conflict',
    spokenGuidance:
      'SafeComm Alert. Critical runway conflict. Controller instructed hold short of runway 28 Left and maintain 2000 feet. Pilot read back crossing runway 28 Right and climbing 3000 feet. Hold short immediately.',
    scriptedCorrectedReadback:
      'Stopping immediately, holding short runway 28 Left, maintain 2000, Delta 882.',
    pilotCallsign: 'DAL882',
  },
};

/**
 * Speaks a SafeComm alert for a detected readback discrepancy.
 * Uses the established female SafeComm voice ('assistant') and respects mute, voice settings, and session lifecycle.
 */
export async function speakSafeCommAlert(
  message: string,
  voices: SpeechSynthesisVoice[] = []
): Promise<void> {
  const settings = loadVoiceSettings();
  if (!settings.enabled || settings.muted) {
    return;
  }

  const fullText = `SafeComm alert. ${message}`;
  await speakPhrase(fullText, 'assistant', settings, voices);
}

export async function speakSafeCommVerification(
  outcome: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED',
  message: string,
  voices: SpeechSynthesisVoice[] = []
): Promise<void> {
  const settings = loadVoiceSettings();
  if (!settings.enabled || settings.muted) return;

  if (outcome === 'MATCH') {
    await speakPhrase('Readback verified.', 'assistant', settings, voices);
    return;
  }

  const spokenMessage = message
    .replace(/^UNVERIFIED\s*[—:-]\s*/i, '')
    .replace(' — ', ': ');
  const prefix = outcome === 'MISMATCH' ? 'Warning.' : 'Readback unverified.';
  await speakPhrase(`${prefix} ${spokenMessage}`, 'assistant', settings, voices);
}
