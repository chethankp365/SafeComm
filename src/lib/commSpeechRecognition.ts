/**
 * SafeComm — Dedicated Speech Recognition Service (ASR)
 * 
 * Manages browser speech recognition and the hosted transcription fallback for PTT audio.
 */

export type SpeechRecognitionStatus =
  | 'idle'
  | 'listening'
  | 'transmitting'
  | 'unsupported'
  | 'error'
  | 'network_error'
  | 'hosted_transcribing'
  | 'hosted_error';

export interface SpeechRecognitionCallbacks {
  onStatusChange: (status: SpeechRecognitionStatus) => void;
  onInterimSpeech: (text: string) => void;
  onFinalSpeech: (text: string, provisional?: boolean) => void;
}

export interface SpeechRecognitionServiceOptions {
  getAudioStream?: () => MediaStream | null;
  transcribeAudio?: (audio: Blob) => Promise<string>;
  finalizationDelayMs?: number;
}

export function isBrowserSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
  );
}

export class SpeechRecognitionService {
  private recognizer: any = null;
  private callbacks: SpeechRecognitionCallbacks;
  private options: SpeechRecognitionServiceOptions;

  private isTransmitting = false;
  private pttLocked = false;
  private isMuted = false;
  private isActive = false;
  private isStarting = false;
  private isCleanedUp = false;

  private pendingReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private interimUtterance = '';
  private finalizedUtteranceParts: string[] = [];
  private seenFinalResultIndexes = new Set<number>();
  private failedForCurrentTransmission = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordingPromise: Promise<Blob | null> | null = null;
  private resolveRecording: ((audio: Blob | null) => void) | null = null;
  private audioCaptureError: string | null = null;
  private transmissionGeneration = 0;

  constructor(callbacks: SpeechRecognitionCallbacks, options: SpeechRecognitionServiceOptions = {}) {
    this.callbacks = callbacks;
    this.options = options;
  }

  /**
   * Initializes SpeechRecognition engine
   */
  public initialize(): void {
    if (this.isCleanedUp) return;

    if (!isBrowserSpeechRecognitionSupported()) {
      this.callbacks.onStatusChange('unsupported');
      return;
    }

    const SpeechRecClass =
      (window as unknown as { SpeechRecognition?: any }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: any }).webkitSpeechRecognition;

    try {
      this.recognizer = new SpeechRecClass();
      this.recognizer.continuous = true;
      this.recognizer.interimResults = true;
      this.recognizer.maxAlternatives = 5;
      this.recognizer.lang = 'en-US';

      this.recognizer.onresult = (event: any) => {
        let interim = '';
        let receivedResult = false;

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          receivedResult = true;
          const alternatives = Array.from(res) as Array<{ transcript?: string; confidence?: number }>;
          const text = alternatives.reduce((best, candidate) =>
            (candidate.confidence ?? 0) > (best.confidence ?? 0) ? candidate : best,
          alternatives[0] || {}).transcript || '';
          if (res.isFinal) {
            if (text.trim() && !this.seenFinalResultIndexes.has(i)) {
              this.finalizedUtteranceParts.push(text.trim());
              this.seenFinalResultIndexes.add(i);
            }
          } else {
            interim += text;
          }
        }

        if (!receivedResult || !(this.isTransmitting || this.pttLocked || this.pendingReleaseTimer)) return;

        this.interimUtterance = interim.trim();
        this.callbacks.onInterimSpeech(
          [this.finalizedUtteranceParts.join(' '), this.interimUtterance].filter(Boolean).join(' ')
        );

        if (this.pendingReleaseTimer) this.scheduleFinalization();
      };

      this.recognizer.onerror = (event: any) => {
        console.warn('[SafeComm/ASR] Speech recognition error:', event.error);
        if (event.error === 'network') {
          this.failedForCurrentTransmission = true;
          this.callbacks.onStatusChange('network_error');
        } else if (event.error === 'not-allowed') {
          this.failedForCurrentTransmission = true;
          this.callbacks.onStatusChange('error');
        } else if (event.error === 'no-speech' || event.error === 'aborted') {
          // Normal browser silence or restart, remain in idle/listening
          if (!this.isTransmitting && !this.pttLocked) {
            this.callbacks.onStatusChange('idle');
          }
        } else {
          this.failedForCurrentTransmission = true;
          this.callbacks.onStatusChange('error');
        }
      };

      this.recognizer.onend = () => {
        this.isActive = false;
        this.isStarting = false;
        this.seenFinalResultIndexes.clear();
        const transmissionActive = !this.isCleanedUp && !this.isMuted && (this.isTransmitting || this.pttLocked);
        if (transmissionActive && !this.failedForCurrentTransmission) {
          if (this.restartTimeout) clearTimeout(this.restartTimeout);
          this.restartTimeout = setTimeout(() => {
            if (!this.isCleanedUp && !this.isMuted && (this.isTransmitting || this.pttLocked)) {
              this.startSafe();
            }
          }, 300);
        } else if (!transmissionActive && !this.isCleanedUp && !this.isMuted) {
          this.callbacks.onStatusChange('idle');
        }
      };

      // Recognizer initialized in standby state until PTT transmission or user interaction
      this.callbacks.onStatusChange('idle');
    } catch {
      this.callbacks.onStatusChange('unsupported');
    }
  }

  private startSafe(): void {
    if (!this.recognizer || this.isActive || this.isStarting || this.isCleanedUp || this.isMuted) return;
    try {
      this.isStarting = true;
      this.recognizer.start();
      this.isActive = true;
      this.isStarting = false;
      this.callbacks.onStatusChange(this.isTransmitting || this.pttLocked ? 'transmitting' : 'listening');
    } catch (err: any) {
      this.isStarting = false;
      if (err?.name === 'InvalidStateError' || String(err).includes('already started')) {
        this.isActive = true;
        this.callbacks.onStatusChange(this.isTransmitting || this.pttLocked ? 'transmitting' : 'listening');
      } else {
        console.error('[SafeComm/ASR] Failed to start speech recognition:', err);
        this.callbacks.onStatusChange('error');
      }
    }
  }

  public startPTT(): void {
    if (this.isMuted) return;
    if (!this.isTransmitting && !this.pttLocked && this.pendingReleaseTimer) {
      this.flushUtterance();
    }
    if (!this.isTransmitting && !this.pttLocked) {
      this.transmissionGeneration += 1;
      this.failedForCurrentTransmission = false;
      this.finalizedUtteranceParts = [];
      this.seenFinalResultIndexes.clear();
      this.interimUtterance = '';
      this.startAudioCapture();
    }
    this.isTransmitting = true;
    if (this.pendingReleaseTimer) {
      clearTimeout(this.pendingReleaseTimer);
      this.pendingReleaseTimer = null;
    }

    this.startSafe();
    this.callbacks.onStatusChange('transmitting');
  }

  public stopPTT(): void {
    if (this.pttLocked) return;
    this.isTransmitting = false;
    if (!this.failedForCurrentTransmission) this.callbacks.onStatusChange('listening');

    this.stopAudioCapture();
    this.scheduleFinalization();
  }

  private scheduleFinalization(): void {
    if (this.pendingReleaseTimer) clearTimeout(this.pendingReleaseTimer);
    const delay = this.options.finalizationDelayMs ?? 2500;
    this.pendingReleaseTimer = setTimeout(() => {
      this.pendingReleaseTimer = null;
      this.flushUtterance();
    }, delay);
  }

  private flushUtterance(): void {
    const finalizedText = this.finalizedUtteranceParts.join(' ').replace(/\s+/g, ' ').trim();
    const interimText = this.interimUtterance.replace(/\s+/g, ' ').trim();
    const text = [finalizedText, interimText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const provisional = Boolean(interimText) || this.failedForCurrentTransmission;
    const generation = this.transmissionGeneration;
    this.finalizedUtteranceParts = [];
    this.seenFinalResultIndexes.clear();
    this.interimUtterance = '';
    this.callbacks.onInterimSpeech('');

    const transcribeAudio = this.options.transcribeAudio;
    if (transcribeAudio && (provisional || !text)) {
      this.callbacks.onStatusChange('hosted_transcribing');
      const recording = this.stopAudioCapture();
      if (!recording) {
        this.handleHostedTranscriptionFailure(
          text,
          generation,
          new Error(this.audioCaptureError || 'Audio capture was unavailable for speech fallback.')
        );
        return;
      }

      void recording
        .then((audio) => {
          if (!audio) throw new Error(this.audioCaptureError || 'The recorded audio was empty.');
          return transcribeAudio(audio);
        })
        .then((transcript) => {
          if (!transcript.trim()) throw new Error('Hosted speech recognizer returned an empty transcript.');
          if (generation === this.transmissionGeneration) {
            this.callbacks.onStatusChange('idle');
          }
          this.callbacks.onFinalSpeech(transcript.trim());
        })
        .catch((error: unknown) => {
          this.handleHostedTranscriptionFailure(text, generation, error);
        })
        .finally(() => {
          if (this.recordingPromise === recording) this.recordingPromise = null;
        });
      return;
    }

    this.discardAudioCapture();
    if (text) {
      if (provisional) this.callbacks.onFinalSpeech(text, true);
      else this.callbacks.onFinalSpeech(text);
    }
  }

  private startAudioCapture(): void {
    const getAudioStream = this.options.getAudioStream;
    if (!getAudioStream || typeof MediaRecorder === 'undefined') return;

    try {
      const stream = getAudioStream();
      if (!stream) {
        this.audioCaptureError = 'The microphone audio stream is unavailable.';
        return;
      }

      const supportedTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? supportedTypes.find((type) => MediaRecorder.isTypeSupported(type))
        : undefined;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      this.audioCaptureError = null;
      const recording = new Promise<Blob | null>((resolve) => {
        this.resolveRecording = resolve;
        recorder.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = (event: Event) => {
          const error = (event as Event & { error?: Error }).error;
          this.audioCaptureError = error?.message || 'Browser audio recording failed.';
          console.warn('[SafeComm/ASR] Audio fallback recording failed:', this.audioCaptureError);
        };
        recorder.onstop = () => {
          const type = recorder.mimeType || chunks.find((chunk) => chunk.type)?.type || 'audio/webm';
          const blob = new Blob(chunks, { type });
          resolve(blob.size > 0 ? blob : null);
          if (this.mediaRecorder === recorder) {
            this.mediaRecorder = null;
            this.resolveRecording = null;
          }
        };
      });

      this.mediaRecorder = recorder;
      this.recordingPromise = recording;
      recorder.start();
    } catch (error) {
      this.mediaRecorder = null;
      this.recordingPromise = null;
      this.resolveRecording = null;
      this.audioCaptureError = error instanceof Error ? error.message : String(error);
      console.warn('[SafeComm/ASR] Could not start audio fallback recording:', this.audioCaptureError);
    }
  }

  private stopAudioCapture(): Promise<Blob | null> | null {
    const recording = this.recordingPromise;
    const recorder = this.mediaRecorder;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch (error) {
        this.audioCaptureError = error instanceof Error ? error.message : String(error);
        console.warn('[SafeComm/ASR] Could not stop audio fallback recording:', this.audioCaptureError);
        this.resolveRecording?.(null);
        this.resolveRecording = null;
        this.mediaRecorder = null;
      }
    }
    return recording;
  }

  private discardAudioCapture(): void {
    const recording = this.stopAudioCapture();
    if (recording) {
      void recording.then(() => {
        if (this.recordingPromise === recording) this.recordingPromise = null;
      });
    }
  }

  private handleHostedTranscriptionFailure(
    text: string,
    generation: number,
    error: unknown
  ): void {
    console.error('[SafeComm/ASR] Hosted speech transcription failed:', error);
    if (generation === this.transmissionGeneration) {
      this.callbacks.onStatusChange('hosted_error');
    }
    if (text) this.callbacks.onFinalSpeech(text, true);
  }

  public togglePTTLock(): boolean {
    this.pttLocked = !this.pttLocked;
    if (this.pttLocked) {
      this.transmissionGeneration += 1;
      this.failedForCurrentTransmission = false;
      if (this.pendingReleaseTimer) {
        clearTimeout(this.pendingReleaseTimer);
        this.pendingReleaseTimer = null;
      }
      this.finalizedUtteranceParts = [];
      this.seenFinalResultIndexes.clear();
      this.interimUtterance = '';
      this.startAudioCapture();
      this.isTransmitting = true;
      this.startSafe();
      this.callbacks.onStatusChange('transmitting');
    } else {
      this.isTransmitting = false;
      if (!this.failedForCurrentTransmission) this.callbacks.onStatusChange('listening');
      this.stopAudioCapture();
      this.scheduleFinalization();
    }
    return this.pttLocked;
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.isMuted) {
      if (this.pendingReleaseTimer) {
        clearTimeout(this.pendingReleaseTimer);
        this.pendingReleaseTimer = null;
      }
      this.isTransmitting = false;
      this.pttLocked = false;
      this.stopAudioCapture();
      this.flushUtterance();
      if (this.recognizer && this.isActive) {
        try {
          this.recognizer.stop();
        } catch {
          // ignore
        }
      }
      this.callbacks.onStatusChange('idle');
    } else {
      this.startSafe();
    }
  }

  public cleanup(): void {
    this.isCleanedUp = true;
    if (this.restartTimeout) clearTimeout(this.restartTimeout);
    if (this.pendingReleaseTimer) clearTimeout(this.pendingReleaseTimer);
    this.discardAudioCapture();
    if (this.recognizer) {
      try {
        if (typeof this.recognizer.stop === 'function') {
          this.recognizer.stop();
        } else if (typeof this.recognizer.abort === 'function') {
          this.recognizer.abort();
        }
      } catch {
        // ignore
      }
      this.recognizer = null;
    }
  }
}
