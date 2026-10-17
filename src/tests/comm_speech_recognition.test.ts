import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechRecognitionService } from '../lib/commSpeechRecognition';

describe('SpeechRecognitionService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('selects the highest-confidence alternative and publishes the full phrase once after PTT', () => {
    class MockSpeechRecognition {
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      lang = '';
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        recognizers.push(this);
      }
    }
    const recognizers: MockSpeechRecognition[] = [];

    vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
    const onFinalSpeech = vi.fn();
    const service = new SpeechRecognitionService({
      onStatusChange: vi.fn(),
      onInterimSpeech: vi.fn(),
      onFinalSpeech,
    });

    service.initialize();
    service.startPTT();
    const recognizer = recognizers[0];
    expect(recognizer?.maxAlternatives).toBe(5);
    const result = Object.assign([
      { transcript: 'turn left heading 270', confidence: 0.4 },
      { transcript: 'turn right heading 270', confidence: 0.9 },
    ], { isFinal: true });
    recognizer?.onresult?.({
      resultIndex: 0,
      results: [result],
    });

    expect(onFinalSpeech).not.toHaveBeenCalled();
    vi.useFakeTimers();
    service.stopPTT();
    vi.advanceTimersByTime(2500);
    expect(onFinalSpeech).toHaveBeenCalledWith('turn right heading 270');
    expect(onFinalSpeech).toHaveBeenCalledTimes(1);
    service.cleanup();
  });

  it('keeps the PTT window open after late recognition updates and combines split final segments', () => {
    vi.useFakeTimers();
    class MockSpeechRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        recognizers.push(this);
      }
    }
    const recognizers: MockSpeechRecognition[] = [];

    vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
    const onFinalSpeech = vi.fn();
    const service = new SpeechRecognitionService({
      onStatusChange: vi.fn(),
      onInterimSpeech: vi.fn(),
      onFinalSpeech,
    });

    service.initialize();
    service.startPTT();
    const recognizer = recognizers[0];
    const firstFinal = Object.assign([
      { transcript: 'turn right', confidence: 0.9 },
    ], { isFinal: true });
    recognizer?.onresult?.({ resultIndex: 0, results: [firstFinal] });
    service.stopPTT();
    vi.advanceTimersByTime(1000);
    const secondFinal = Object.assign([
      { transcript: 'heading 090', confidence: 0.9 },
    ], { isFinal: true });
    recognizer?.onresult?.({ resultIndex: 1, results: [firstFinal, secondFinal] });

    expect(onFinalSpeech).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2499);
    expect(onFinalSpeech).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFinalSpeech).toHaveBeenCalledWith('turn right heading 090');
    expect(onFinalSpeech).toHaveBeenCalledTimes(1);
    service.cleanup();
  });

  it('preserves an interim speech tail after finalized words and keeps the result provisional', () => {
    vi.useFakeTimers();
    class MockSpeechRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        recognizers.push(this);
      }
    }
    const recognizers: MockSpeechRecognition[] = [];

    vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
    const onFinalSpeech = vi.fn();
    const service = new SpeechRecognitionService({
      onStatusChange: vi.fn(),
      onInterimSpeech: vi.fn(),
      onFinalSpeech,
    });

    service.initialize();
    service.startPTT();
    const finalHeading = Object.assign([
      { transcript: 'Speedbird 214 turn right heading', confidence: 0.95 },
    ], { isFinal: true });
    const interimTail = Object.assign([
      { transcript: '090 runway 27 assigned', confidence: 0.8 },
    ], { isFinal: false });
    recognizers[0]?.onresult?.({ resultIndex: 0, results: [finalHeading, interimTail] });
    service.stopPTT();
    vi.advanceTimersByTime(2500);

    expect(onFinalSpeech).toHaveBeenCalledWith(
      'Speedbird 214 turn right heading 090 runway 27 assigned',
      true
    );
    expect(onFinalSpeech).toHaveBeenCalledTimes(1);
    service.cleanup();
  });

  it('finalizes interim-only recognition as provisional after the release timeout', () => {
    vi.useFakeTimers();
    class MockSpeechRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      constructor() {
        recognizers.push(this);
      }
    }
    const recognizers: MockSpeechRecognition[] = [];

    vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
    const onFinalSpeech = vi.fn();
    const service = new SpeechRecognitionService({
      onStatusChange: vi.fn(),
      onInterimSpeech: vi.fn(),
      onFinalSpeech,
    });

    service.initialize();
    service.startPTT();
    const interim = Object.assign([
      { transcript: 'turn left heading 090', confidence: 0.9 },
    ], { isFinal: false });
    recognizers[0]?.onresult?.({ resultIndex: 0, results: [interim] });
    service.stopPTT();
    vi.advanceTimersByTime(2500);

    expect(onFinalSpeech).toHaveBeenCalledWith('turn left heading 090', true);
    expect(onFinalSpeech).toHaveBeenCalledTimes(1);
    service.cleanup();
  });

  it('stops retrying after a network error and marks captured text provisional', () => {
    vi.useFakeTimers();
    class MockSpeechRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        recognizers.push(this);
      }
    }
    const recognizers: MockSpeechRecognition[] = [];

    vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
    const onStatusChange = vi.fn();
    const onFinalSpeech = vi.fn();
    const service = new SpeechRecognitionService({
      onStatusChange,
      onInterimSpeech: vi.fn(),
      onFinalSpeech,
    });

    service.initialize();
    service.startPTT();
    const recognizer = recognizers[0];
    const finalResult = Object.assign([
      { transcript: 'turn right heading 090', confidence: 0.9 },
    ], { isFinal: true });
    recognizer?.onresult?.({ resultIndex: 0, results: [finalResult] });
    recognizer?.onerror?.({ error: 'network' });
    recognizer?.onend?.();
    vi.advanceTimersByTime(1000);

    expect(recognizer?.start).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenLastCalledWith('network_error');

    service.stopPTT();
    vi.advanceTimersByTime(2500);
    expect(onFinalSpeech).toHaveBeenCalledWith('turn right heading 090', true);
    expect(onFinalSpeech).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenLastCalledWith('network_error');

    service.startPTT();
    expect(recognizer?.start).toHaveBeenCalledTimes(2);
    service.cleanup();
  });

  it('uses hosted transcription when browser speech recognition fails with a network error', async () => {
    vi.useFakeTimers();
    class MockSpeechRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        recognizers.push(this);
      }
    }
    class MockMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;
      start = vi.fn(() => {
        this.state = 'recording';
      });
      stop = vi.fn(() => {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recorded voice'], { type: this.mimeType }) });
        this.onstop?.();
      });

      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
        recorders.push(this);
      }
    }
    const recognizers: MockSpeechRecognition[] = [];
    const recorders: MockMediaRecorder[] = [];

    vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    const onFinalSpeech = vi.fn();
    const transcribeAudio = vi.fn().mockResolvedValue(
      'Speedbird 214 turn right heading 090 runway 27 assigned'
    );
    const service = new SpeechRecognitionService({
      onStatusChange: vi.fn(),
      onInterimSpeech: vi.fn(),
      onFinalSpeech,
    }, {
      getAudioStream: () => ({} as MediaStream),
      transcribeAudio,
    });

    service.initialize();
    service.startPTT();
    expect(recorders[0]?.start).toHaveBeenCalledTimes(1);
    recognizers[0]?.onerror?.({ error: 'network' });
    service.stopPTT();
    await vi.advanceTimersByTimeAsync(2500);

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(await transcribeAudio.mock.results[0]?.value).toBe(
      'Speedbird 214 turn right heading 090 runway 27 assigned'
    );
    expect(onFinalSpeech).toHaveBeenCalledWith(
      'Speedbird 214 turn right heading 090 runway 27 assigned'
    );
    expect(onFinalSpeech).toHaveBeenCalledTimes(1);
    service.cleanup();
  });

  it('keeps complete browser transcripts local instead of uploading their audio', async () => {
    vi.useFakeTimers();
    class MockSpeechRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        recognizers.push(this);
      }
    }
    class MockMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;
      start = vi.fn(() => {
        this.state = 'recording';
      });
      stop = vi.fn(() => {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recorded voice'], { type: this.mimeType }) });
        this.onstop?.();
      });

      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
        recorders.push(this);
      }
    }
    const recognizers: MockSpeechRecognition[] = [];
    const recorders: MockMediaRecorder[] = [];

    vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    const onFinalSpeech = vi.fn();
    const transcribeAudio = vi.fn();
    const service = new SpeechRecognitionService({
      onStatusChange: vi.fn(),
      onInterimSpeech: vi.fn(),
      onFinalSpeech,
    }, {
      getAudioStream: () => ({} as MediaStream),
      transcribeAudio,
    });

    service.initialize();
    service.startPTT();
    const finalResult = Object.assign([
      { transcript: 'Speedbird 214 turn right heading 090', confidence: 0.95 },
    ], { isFinal: true });
    recognizers[0]?.onresult?.({ resultIndex: 0, results: [finalResult] });
    service.stopPTT();
    await vi.advanceTimersByTimeAsync(2500);

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(onFinalSpeech).toHaveBeenCalledWith('Speedbird 214 turn right heading 090');
    expect(onFinalSpeech).toHaveBeenCalledTimes(1);
    expect(recorders[0]?.stop).toHaveBeenCalledTimes(1);
    service.cleanup();
  });

  it('keeps browser fragments provisional when hosted transcription also fails', async () => {
    vi.useFakeTimers();
    class MockSpeechRecognition {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();

      constructor() {
        recognizers.push(this);
      }
    }
    class MockMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;
      start = vi.fn(() => {
        this.state = 'recording';
      });
      stop = vi.fn(() => {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['recorded voice'], { type: this.mimeType }) });
        this.onstop?.();
      });

      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
        recorders.push(this);
      }
    }
    const recognizers: MockSpeechRecognition[] = [];
    const recorders: MockMediaRecorder[] = [];

    vi.stubGlobal('window', { SpeechRecognition: MockSpeechRecognition });
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    const onStatusChange = vi.fn();
    const onFinalSpeech = vi.fn();
    const transcribeAudio = vi.fn().mockRejectedValue(new Error('Hosted ASR unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new SpeechRecognitionService({
      onStatusChange,
      onInterimSpeech: vi.fn(),
      onFinalSpeech,
    }, {
      getAudioStream: () => ({} as MediaStream),
      transcribeAudio,
    });

    service.initialize();
    service.startPTT();
    const fragment = Object.assign([
      { transcript: 'heading 090', confidence: 0.9 },
    ], { isFinal: true });
    recognizers[0]?.onresult?.({ resultIndex: 0, results: [fragment] });
    recognizers[0]?.onerror?.({ error: 'network' });
    service.stopPTT();
    await vi.advanceTimersByTimeAsync(2500);

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(onFinalSpeech).toHaveBeenCalledWith('heading 090', true);
    expect(onFinalSpeech).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenLastCalledWith('hosted_error');
    service.cleanup();
  });
});
