import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  Radio,
  ShieldCheck,
  AlertTriangle,
  Cpu,
  Plane,
  Sparkles,
  CheckCircle2,
  XCircle,
  Database,
  Volume2,
  VolumeX,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  ArrowRight,
} from 'lucide-react';
import { ATC_SCENARIOS, type Scenario } from '../data/scenarios';
import { extractInstructions, type ExtractionResult } from '../lib/llmExtractor';
import {
  diffExtractions,
  syncTransmissionToSupabase,
  type VerificationVerdictStub,
} from '../lib/databaseSync';
import {
  type SpeakerRole,
  type VoiceSettings,
  loadVoiceSettings,
  saveVoiceSettings,
  playRadioTone,
  isSpeechSynthesisSupported,
  onVoicesChanged,
  previewVoice,
  stopVoicePreview,
  speakPhrase,
  cancelAllSpeech,
  pauseSpeech,
  resumeSpeech,
  SCENARIO_TRAINING_CORRECTIONS,
} from '../lib/speechAudio';
import { useAuth } from '../context/AuthContext';
import { CommRoomModal } from '../components/comm/CommRoomModal';
import { getActiveSession, clearActiveSession } from '../lib/commRooms';
import './Dashboard.css';

interface DisplayedTransmission {
  id: string;
  role: 'controller' | 'pilot';
  speaker: string;
  callsign: string;
  text: string;
  timestamp: string;
  extraction: ExtractionResult | null;
  isExtracting: boolean;
  verdict?: VerificationVerdictStub | null;
}

interface ActiveAlertItem {
  id: string;
  severity: 'OK' | 'WARNING' | 'CRITICAL';
  headline: string;
  explanation: string;
  timestamp: string;
  callsign: string;
}

interface ActiveCorrectionState {
  scenarioId: string;
  deviationTitle: string;
  spokenGuidance: string;
  scriptedCorrectedReadback: string;
  pilotCallsign: string;
  mismatchedFields: string[];
  replayingCorrection: boolean;
  retryingReadback: boolean;
  retryCompleted: boolean;
}

export const Dashboard: React.FC = () => {
  const { user, createDatabaseSession } = useAuth();
  const navigate = useNavigate();
  const [activeCommSession, setActiveCommSession] = useState(getActiveSession);

  useEffect(() => {
    setActiveCommSession(getActiveSession());
  }, []);

  // Selected scenario
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(ATC_SCENARIOS[0].id);
  const currentScenario: Scenario =
    ATC_SCENARIOS.find((s) => s.id === selectedScenarioId) || ATC_SCENARIOS[0];

  // Simulation playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [displayedLines, setDisplayedLines] = useState<DisplayedTransmission[]>([]);
  const [activeAlerts, setActiveAlerts] = useState<ActiveAlertItem[]>([]);
  const [lastComparison, setLastComparison] = useState<{
    controllerExt: ExtractionResult;
    pilotExt: ExtractionResult;
    verdict: VerificationVerdictStub;
  } | null>(null);

  // Active parser mode reported in UI
  const [activeParser, setActiveParser] = useState<string>('Detecting...');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [dbSyncCount, setDbSyncCount] = useState<number>(0);
  const [dbStatus, setDbStatus] = useState<'idle' | 'syncing' | 'connected' | 'error'>('idle');
  const [lastDbError, setLastDbError] = useState<string | null>(null);

  // Voice Playback & Simulated Audio State
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(loadVoiceSettings);
  const [previewingRole, setPreviewingRole] = useState<SpeakerRole | null>(null);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [activeSpeaker, setActiveSpeaker] = useState<{
    role: SpeakerRole;
    speaker: string;
    callsign: string;
    text: string;
  } | null>(null);

  // Simulated Training Guidance & Correction State
  const [activeCorrection, setActiveCorrection] = useState<ActiveCorrectionState | null>(null);

  // Communication Room Modal State
  const [isCommModalOpen, setIsCommModalOpen] = useState<boolean>(false);

  const isCancelledRef = useRef(false);
  const isPausedRef = useRef(false);
  const transcriptBottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayedLines]);

  const updateVoiceSettings = (updater: (prev: VoiceSettings) => VoiceSettings) => {
    setVoiceSettings((prev) => {
      const next = updater(prev);
      saveVoiceSettings(next);
      return next;
    });
  };

  const handlePreviewVoice = async (role: SpeakerRole) => {
    if (previewingRole === role) {
      stopVoicePreview();
      setPreviewingRole(null);
      return;
    }
    stopVoicePreview();
    setPreviewingRole(role);
    const chosenVoiceName =
      role === 'assistant'
        ? voiceSettings.assistantVoiceName
        : role === 'controller'
        ? voiceSettings.controllerVoiceName
        : voiceSettings.pilotVoiceName;

    await previewVoice(chosenVoiceName, role, voiceSettings, availableVoices);
    setPreviewingRole(null);
  };

  // Initial check of parser and asynchronous voice listener
  useEffect(() => {
    extractInstructions('Test transmission ping')
      .then((res) => {
        setActiveParser(res.parserType);
      })
      .catch(() => {
        setActiveParser('Local Parser');
      });

    if (isSpeechSynthesisSupported()) {
      const unsub = onVoicesChanged((voices) => {
        setAvailableVoices(voices);
      });
      return () => {
        unsub();
        stopVoicePreview();
        cancelAllSpeech();
      };
    } else {
      setSpeechSupported(false);
    }
  }, []);

  // Stop simulation & cancel speech on unmount
  useEffect(() => {
    return () => {
      isCancelledRef.current = true;
      stopVoicePreview();
      cancelAllSpeech();
    };
  }, []);

  const handleReset = () => {
    isCancelledRef.current = true;
    isPausedRef.current = false;
    stopVoicePreview();
    setPreviewingRole(null);
    cancelAllSpeech();
    setIsPlaying(false);
    setIsPaused(false);
    setActiveSpeaker(null);
    setDisplayedLines([]);
    setActiveAlerts([]);
    setLastComparison(null);
    setActiveCorrection(null);
  };

  const handlePause = () => {
    setIsPaused(true);
    isPausedRef.current = true;
    pauseSpeech();
  };

  const handleResume = () => {
    setIsPaused(false);
    isPausedRef.current = false;
    resumeSpeech();
  };

  const handleStop = () => {
    isCancelledRef.current = true;
    isPausedRef.current = false;
    stopVoicePreview();
    setPreviewingRole(null);
    cancelAllSpeech();
    setIsPlaying(false);
    setIsPaused(false);
    setActiveSpeaker(null);
  };

  const checkPauseAndCancel = async (): Promise<boolean> => {
    while (isPausedRef.current && !isCancelledRef.current) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return isCancelledRef.current;
  };

  const handlePlayScenario = async () => {
    handleReset();
    isCancelledRef.current = false;
    isPausedRef.current = false;
    setIsPlaying(true);
    setIsPaused(false);

    // Initialize or obtain a Supabase session
    let currentSession = activeSessionId;
    if (!currentSession) {
      setDbStatus('syncing');
      setLastDbError(null);
      const { id, error } = await createDatabaseSession(`Simulation: ${currentScenario.name}`);
      if (error || !id) {
        console.error('[SafeComm Error] Supabase session initialization error:', error?.message);
        setLastDbError(error?.message || 'Could not initialize Supabase session');
        setDbStatus('error');
      } else {
        currentSession = id;
        setActiveSessionId(id);
        setDbStatus('connected');
        console.log('[SafeComm Supabase] Active session established:', id);
      }
    }

    let prevControllerLine: DisplayedTransmission | null = null;

    for (let i = 0; i < currentScenario.lines.length; i++) {
      if (await checkPauseAndCancel()) break;

      const scriptLine = currentScenario.lines[i];

      // Delay before speaking line (preserves scenario cadence)
      const interPause =
        voiceSettings.enabled && !voiceSettings.muted
          ? Math.min(scriptLine.delayMs, 1000)
          : scriptLine.delayMs;
      await new Promise((resolve) => setTimeout(resolve, interPause));
      if (await checkPauseAndCancel()) break;

      const now = new Date();
      const zuluTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(
        now.getUTCMinutes()
      ).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}Z`;

      const newTransmission: DisplayedTransmission = {
        id: scriptLine.id,
        role: scriptLine.role,
        speaker: scriptLine.speaker,
        callsign: scriptLine.callsign,
        text: scriptLine.text,
        timestamp: zuluTime,
        extraction: null,
        isExtracting: true,
      };

      setDisplayedLines((prev) => [...prev, newTransmission]);

      // Set visible active speaker state
      setActiveSpeaker({
        role: scriptLine.role,
        speaker: scriptLine.speaker,
        callsign: scriptLine.callsign,
        text: scriptLine.text,
      });

      // Voice playback: speak phrase in sequence with distinct voice
      if (voiceSettings.enabled && !voiceSettings.muted) {
        await speakPhrase(scriptLine.text, scriptLine.role, voiceSettings, availableVoices);
      }
      if (await checkPauseAndCancel()) break;
      setActiveSpeaker(null);

      // Call LLM / Rule-based Extraction
      const extraction = await extractInstructions(scriptLine.text);
      if (await checkPauseAndCancel()) break;

      setActiveParser(extraction.parserType);

      let verdict: VerificationVerdictStub | undefined = undefined;

      // If this is a pilot line and we have a preceding controller line, compare!
      if (scriptLine.role === 'pilot' && prevControllerLine && prevControllerLine.extraction) {
        verdict = diffExtractions(prevControllerLine.extraction, extraction);

        console.log('[SafeComm Read-back Verification Verdict]', {
          scenario: currentScenario.name,
          outcome: verdict.outcome,
          severity: verdict.severity,
          explanation: verdict.explanation,
        });

        setLastComparison({
          controllerExt: prevControllerLine.extraction,
          pilotExt: extraction,
          verdict,
        });

        // Trigger Alert and Spoken Correction if mismatch detected
        if (verdict.outcome === 'MISMATCH') {
          const newAlert: ActiveAlertItem = {
            id: `alert-${Date.now()}`,
            severity: verdict.severity,
            headline:
              verdict.severity === 'CRITICAL'
                ? 'CRITICAL READ-BACK DEVIATION'
                : 'PHRASEOLOGY WARNING',
            explanation: verdict.explanation,
            timestamp: zuluTime,
            callsign: scriptLine.callsign,
          };
          setActiveAlerts((prev) => [newAlert, ...prev]);

          // Play warning chime sound
          playRadioTone('alert_chime');

          // Look up simulated training correction
          const correctionData = SCENARIO_TRAINING_CORRECTIONS[currentScenario.id];
          if (correctionData && correctionData.hasCorrection) {
            setActiveCorrection({
              scenarioId: currentScenario.id,
              deviationTitle: correctionData.deviationTitle,
              spokenGuidance: correctionData.spokenGuidance,
              scriptedCorrectedReadback: correctionData.scriptedCorrectedReadback,
              pilotCallsign: correctionData.pilotCallsign,
              mismatchedFields: verdict.mismatchedFields,
              replayingCorrection: false,
              retryingReadback: false,
              retryCompleted: false,
            });

            // Speak simulated SafeComm correction after pilot read-back has finished
            if (voiceSettings.enabled && !voiceSettings.muted) {
              if (await checkPauseAndCancel()) break;

              setActiveSpeaker({
                role: 'assistant',
                speaker: 'SafeComm Safety Advisor',
                callsign: 'SYS-ADVISORY',
                text: correctionData.spokenGuidance,
              });

              await speakPhrase(
                correctionData.spokenGuidance,
                'assistant',
                voiceSettings,
                availableVoices
              );
              if (await checkPauseAndCancel()) break;
              setActiveSpeaker(null);
            }
          }
        }
      }

      // Update displayed transmission with extraction & verdict
      setDisplayedLines((prev) =>
        prev.map((t) =>
          t.id === scriptLine.id
            ? { ...t, extraction, isExtracting: false, verdict: verdict || null }
            : t
        )
      );

      // Track preceding controller line
      if (scriptLine.role === 'controller') {
        prevControllerLine = {
          ...newTransmission,
          extraction,
          isExtracting: false,
        };
      }

      // Sync to Supabase with proper awaiting and error propagation
      if (currentSession) {
        const syncRes = await syncTransmissionToSupabase(
          currentSession,
          scriptLine.role,
          scriptLine.text,
          extraction.callsign,
          extraction.instructions,
          verdict
        );

        if (syncRes.success) {
          setDbSyncCount((c) => c + 1);
          setDbStatus('connected');
        } else {
          console.error('[SafeComm Supabase Sync Error]', syncRes.error);
          setLastDbError(syncRes.error);
          setDbStatus('error');
        }
      }
    }

    setIsPlaying(false);
    setIsPaused(false);
    isPausedRef.current = false;
    setActiveSpeaker(null);
  };

  // Replay simulated correction (audio only, no database sync)
  const handleReplayCorrection = async () => {
    if (!activeCorrection || !activeCorrection.spokenGuidance) return;
    cancelAllSpeech();
    setActiveCorrection((prev) => (prev ? { ...prev, replayingCorrection: true } : null));

    setActiveSpeaker({
      role: 'assistant',
      speaker: 'SafeComm Safety Advisor',
      callsign: 'SYS-ADVISORY',
      text: activeCorrection.spokenGuidance,
    });

    if (voiceSettings.enabled && !voiceSettings.muted) {
      playRadioTone('alert_chime');
      await speakPhrase(
        activeCorrection.spokenGuidance,
        'assistant',
        voiceSettings,
        availableVoices
      );
    } else {
      await new Promise((r) => setTimeout(r, 1200));
    }

    setActiveSpeaker(null);
    setActiveCorrection((prev) => (prev ? { ...prev, replayingCorrection: false } : null));
  };

  // Repeat corrected read-back (audio only, clearly labelled, no database sync)
  const handleRepeatCorrectedReadback = async () => {
    if (!activeCorrection || !activeCorrection.scriptedCorrectedReadback) return;
    cancelAllSpeech();
    setActiveCorrection((prev) => (prev ? { ...prev, retryingReadback: true } : null));

    setActiveSpeaker({
      role: 'pilot',
      speaker: `Flight Crew ${activeCorrection.pilotCallsign} (Simulated Trainee Response)`,
      callsign: activeCorrection.pilotCallsign,
      text: activeCorrection.scriptedCorrectedReadback,
    });

    if (voiceSettings.enabled && !voiceSettings.muted) {
      playRadioTone('mic_click');
      await speakPhrase(
        activeCorrection.scriptedCorrectedReadback,
        'pilot',
        voiceSettings,
        availableVoices
      );
    } else {
      await new Promise((r) => setTimeout(r, 1200));
    }

    setActiveSpeaker(null);
    setActiveCorrection((prev) =>
      prev ? { ...prev, retryingReadback: false, retryCompleted: true } : null
    );
  };

  // Metrics calculations
  const totalCount = displayedLines.length;
  const mismatchCount = displayedLines.filter((l) => l.verdict?.outcome === 'MISMATCH').length;
  const matchCount = displayedLines.filter((l) => l.verdict?.outcome === 'MATCH').length;
  const totalVerdicts = mismatchCount + matchCount;
  const complianceRate =
    totalVerdicts > 0 ? ((matchCount / totalVerdicts) * 100).toFixed(1) : '100.0';

  return (
    <div className="dashboard-container">
      {/* Active Communication Session Banner */}
      {activeCommSession && (
        <section
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            background: 'rgba(0, 113, 227, 0.08)',
            border: '1px solid rgba(0, 113, 227, 0.25)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 'var(--space-3)',
            fontSize: '13px',
          }}
          aria-label="Active Communication Room Notice"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Radio size={16} color="#0071E3" className="connect-comm-beacon" />
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Active Operational Communication Room: {activeCommSession.joinCode}
            </span>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
              ({activeCommSession.role === 'atc' ? 'ATC Controller' : 'Pilot Cockpit'})
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={() => navigate(`/comm/${activeCommSession.roomId}`)}
              style={{
                padding: '6px 14px',
                background: '#0071E3',
                color: '#FFFFFF',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <span>Resume Comm Session</span>
              <ArrowRight size={12} />
            </button>
            <button
              type="button"
              onClick={() => {
                clearActiveSession();
                setActiveCommSession(null);
              }}
              style={{
                padding: '6px 10px',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 12,
                border: 'none',
                cursor: 'pointer',
              }}
              title="Dismiss banner"
            >
              Dismiss
            </button>
          </div>
        </section>
      )}

      {/* Simulation Control Bar */}
      <section className="dashboard-control-bar" aria-label="Scenario Controls">
        <div className="control-bar-left">
          <div className="control-bar-meta">
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                background: isPlaying
                  ? 'rgba(0, 113, 227, 0.12)'
                  : isPaused
                  ? 'rgba(255, 159, 10, 0.12)'
                  : 'var(--accent-match-bg)',
                color: isPlaying ? '#0071E3' : isPaused ? '#B45309' : '#107C41',
                border: isPlaying
                  ? '1px solid rgba(0, 113, 227, 0.25)'
                  : isPaused
                  ? '1px solid rgba(255, 159, 10, 0.25)'
                  : '1px solid var(--accent-match-border)',
                letterSpacing: '0.04em',
              }}
            >
              {isPlaying
                ? isPaused
                  ? '⏸ SIMULATION PAUSED'
                  : '● SIMULATION STREAMING'
                : 'RADIO STANDBY'}
            </span>
            <span
              style={{
                fontSize: '12px',
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {currentScenario.airport} · {currentScenario.frequency}
            </span>
            <span className="simulated-training-tag">Simulated Training Audio</span>
          </div>

          <div className="scenario-select-wrapper" style={{ marginTop: 6 }}>
            <span className="scenario-select-label">Scenario:</span>
            <select
              className="scenario-dropdown"
              value={selectedScenarioId}
              onChange={(e) => {
                handleReset();
                setSelectedScenarioId(e.target.value);
              }}
              disabled={isPlaying}
              aria-label="Select ATC Scenario"
            >
              {ATC_SCENARIOS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.shortTag})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="control-bar-right">
          {/* Active Parser Badge (AI vs Local) */}
          <div
            className={`parser-status-badge ${
              activeParser.includes('Groq')
                ? 'is-ai'
                : 'is-local'
            }`}
            title="Extraction Engine Mode"
          >
            <Cpu size={14} />
            <span>{activeParser}</span>
          </div>

          {/* Voice Audio Controls Group */}
          <div className="voice-controls-cluster">
            <button
              type="button"
              className={`voice-pill-btn ${voiceSettings.enabled ? 'active' : 'inactive'}`}
              onClick={() =>
                updateVoiceSettings((v) => ({ ...v, enabled: !v.enabled }))
              }
              title={
                voiceSettings.enabled
                  ? 'Disable Simulated Training Audio'
                  : 'Enable Simulated Training Audio'
              }
              aria-label="Toggle voice playback"
            >
              <Volume2 size={13} />
              <span>Voice: {voiceSettings.enabled ? 'ON' : 'OFF'}</span>
            </button>

            {voiceSettings.enabled && (
              <button
                type="button"
                className={`voice-mute-btn ${voiceSettings.muted ? 'muted' : ''}`}
                onClick={() => {
                  if (!voiceSettings.muted) {
                    cancelAllSpeech();
                    stopVoicePreview();
                    setPreviewingRole(null);
                  }
                  updateVoiceSettings((v) => ({ ...v, muted: !v.muted }));
                }}
                title={voiceSettings.muted ? 'Unmute radio audio' : 'Mute radio audio'}
                aria-label={voiceSettings.muted ? 'Unmute voice audio' : 'Mute voice audio'}
              >
                {voiceSettings.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
            )}

            <button
              type="button"
              className={`voice-settings-btn ${showAudioSettings ? 'open' : ''}`}
              onClick={() => setShowAudioSettings((s) => !s)}
              title="Voice Rate, Volume & Speaker Selection"
              aria-label="Voice settings"
            >
              <SlidersHorizontal size={14} />
              {showAudioSettings ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>

          {/* Reset Control */}
          <button
            type="button"
            className="sim-btn-reset"
            onClick={handleReset}
            disabled={isPlaying && displayedLines.length === 0}
            title="Reset current feed"
          >
            <RotateCcw size={14} />
            <span>Reset</span>
          </button>

          {/* Pause / Resume Controls during active scenario */}
          {isPlaying && (
            <button
              type="button"
              className="sim-btn-pause"
              onClick={isPaused ? handleResume : handlePause}
              title={isPaused ? 'Resume scenario playback' : 'Pause scenario playback'}
            >
              {isPaused ? <Play size={14} /> : <Pause size={14} />}
              <span>{isPaused ? 'Resume' : 'Pause'}</span>
            </button>
          )}

          {/* Stop Control during active scenario */}
          {isPlaying && (
            <button
              type="button"
              className="sim-btn-stop"
              onClick={handleStop}
              title="Stop scenario and cancel speech"
            >
              <Square size={13} fill="currentColor" />
              <span>Stop</span>
            </button>
          )}

          {/* Connect SafeComm Entry Point */}
          <button
            type="button"
            className="btn-connect-safecomm"
            onClick={() => setIsCommModalOpen(true)}
            title="Connect SafeComm — Create or Join live ATC/Pilot room"
            aria-label="Connect SafeComm communication room"
          >
            <Radio size={14} className="connect-comm-beacon" />
            <span>Connect SafeComm</span>
            <span className="connect-comm-badge">Live</span>
          </button>

          {/* Play Scenario Control */}
          <button
            type="button"
            className="sim-btn-play"
            onClick={handlePlayScenario}
            disabled={isPlaying}
            title="Stream scenario lines in real time"
          >
            <Play size={14} fill="currentColor" />
            <span>{isPlaying ? 'Streaming Radio Feed...' : 'Play Scenario'}</span>
          </button>
        </div>
      </section>

      {/* Expandable Audio Settings Drawer */}
      {showAudioSettings && (
        <section className="audio-settings-drawer" aria-label="Audio Configuration">
          <div className="audio-settings-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Volume2 size={15} color="#0071E3" />
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>
                Simulated Training Audio Controls
              </span>
            </div>
            <span className="speech-support-badge">
              {speechSupported
                ? `Browser Web Speech API (${availableVoices.length} voices loaded)`
                : 'SpeechSynthesis unavailable in this browser (Text-only mode)'}
            </span>
          </div>

          <div className="audio-settings-grid">
            {/* Speed Rate Slider */}
            <div className="setting-card">
              <div className="setting-label-row">
                <span className="setting-name">Transmission Cadence</span>
                <span className="setting-value">{voiceSettings.rate.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min="0.8"
                max="1.3"
                step="0.05"
                value={voiceSettings.rate}
                onChange={(e) =>
                  updateVoiceSettings((v) => ({ ...v, rate: parseFloat(e.target.value) }))
                }
                className="setting-slider"
                aria-label="Speech rate"
              />
              <div className="setting-hint">Standard ATC pacing: 1.05x</div>
            </div>

            {/* Volume Slider */}
            <div className="setting-card">
              <div className="setting-label-row">
                <span className="setting-name">Radio Audio Volume</span>
                <span className="setting-value">{Math.round(voiceSettings.volume * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={voiceSettings.volume}
                onChange={(e) =>
                  updateVoiceSettings((v) => ({ ...v, volume: parseFloat(e.target.value) }))
                }
                className="setting-slider"
                aria-label="Speech volume"
              />
              <div className="setting-hint">Includes simulated radio click & caution chime</div>
            </div>

            {/* SafeComm Advisory Voice Selector */}
            {availableVoices.length > 0 && (
              <div className="setting-card">
                <div className="setting-label-row">
                  <span className="setting-name">SafeComm Advisory Voice</span>
                </div>
                <div className="setting-voice-control-row">
                  <select
                    className="setting-select"
                    value={voiceSettings.assistantVoiceName || ''}
                    onChange={(e) =>
                      updateVoiceSettings((v) => ({
                        ...v,
                        assistantVoiceName: e.target.value || undefined,
                      }))
                    }
                    aria-label="Select SafeComm Advisory Voice"
                  >
                    <option value="">Default (Natural / Clear English)</option>
                    {availableVoices.map((voice) => (
                      <option key={`a-${voice.name}`} value={voice.name}>
                        {voice.name} ({voice.lang})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`voice-preview-btn ${previewingRole === 'assistant' ? 'is-previewing' : ''}`}
                    onClick={() => handlePreviewVoice('assistant')}
                    title="Preview SafeComm Advisory Voice"
                    aria-label="Preview SafeComm Advisory Voice"
                  >
                    {previewingRole === 'assistant' ? (
                      <Square size={11} fill="currentColor" />
                    ) : (
                      <Play size={11} fill="currentColor" />
                    )}
                    <span>{previewingRole === 'assistant' ? 'Stop' : 'Preview'}</span>
                  </button>
                </div>
                <div className="setting-hint">Professional natural-sounding voice for safety advisories</div>
              </div>
            )}

            {/* Controller Voice Selector */}
            {availableVoices.length > 0 && (
              <div className="setting-card">
                <div className="setting-label-row">
                  <span className="setting-name">ATC Controller Voice</span>
                </div>
                <div className="setting-voice-control-row">
                  <select
                    className="setting-select"
                    value={voiceSettings.controllerVoiceName || ''}
                    onChange={(e) =>
                      updateVoiceSettings((v) => ({
                        ...v,
                        controllerVoiceName: e.target.value || undefined,
                      }))
                    }
                    aria-label="Select Controller Voice"
                  >
                    <option value="">Default (Deep / Authoritative ATC)</option>
                    {availableVoices.map((voice) => (
                      <option key={`c-${voice.name}`} value={voice.name}>
                        {voice.name} ({voice.lang})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`voice-preview-btn ${previewingRole === 'controller' ? 'is-previewing' : ''}`}
                    onClick={() => handlePreviewVoice('controller')}
                    title="Preview Controller Voice"
                    aria-label="Preview Controller Voice"
                  >
                    {previewingRole === 'controller' ? (
                      <Square size={11} fill="currentColor" />
                    ) : (
                      <Play size={11} fill="currentColor" />
                    )}
                    <span>{previewingRole === 'controller' ? 'Stop' : 'Preview'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Pilot Voice Selector */}
            {availableVoices.length > 0 && (
              <div className="setting-card">
                <div className="setting-label-row">
                  <span className="setting-name">Flight Crew Voice</span>
                </div>
                <div className="setting-voice-control-row">
                  <select
                    className="setting-select"
                    value={voiceSettings.pilotVoiceName || ''}
                    onChange={(e) =>
                      updateVoiceSettings((v) => ({
                        ...v,
                        pilotVoiceName: e.target.value || undefined,
                      }))
                    }
                    aria-label="Select Pilot Voice"
                  >
                    <option value="">Default (Cockpit Crew)</option>
                    {availableVoices.map((voice) => (
                      <option key={`p-${voice.name}`} value={voice.name}>
                        {voice.name} ({voice.lang})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`voice-preview-btn ${previewingRole === 'pilot' ? 'is-previewing' : ''}`}
                    onClick={() => handlePreviewVoice('pilot')}
                    title="Preview Pilot Voice"
                    aria-label="Preview Pilot Voice"
                  >
                    {previewingRole === 'pilot' ? (
                      <Square size={11} fill="currentColor" />
                    ) : (
                      <Play size={11} fill="currentColor" />
                    )}
                    <span>{previewingRole === 'pilot' ? 'Stop' : 'Preview'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Active Speaker Broadcast Banner */}
      {activeSpeaker && (
        <section
          className={`active-speaker-banner ${activeSpeaker.role}`}
          aria-live="polite"
          aria-label="Active Radio Speaker"
        >
          <div className="speaker-identity-block">
            <span className="speaker-beacon-dot" />
            <span className="speaker-role-label">
              {activeSpeaker.role === 'controller'
                ? 'ATC CONTROLLER TRANSMITTING'
                : activeSpeaker.role === 'pilot'
                ? 'FLIGHT CREW READ-BACK'
                : 'SAFECOMM SIMULATED TRAINING ADVISOR'}
            </span>
            <span className="speaker-name-label">· {activeSpeaker.speaker}</span>
          </div>

          <div className="speaker-waveform-strip" aria-hidden="true">
            <span className="wave-bar wb-1" />
            <span className="wave-bar wb-2" />
            <span className="wave-bar wb-3" />
            <span className="wave-bar wb-4" />
            <span className="wave-bar wb-5" />
          </div>

          <div className="speaker-transcript-quote">"{activeSpeaker.text}"</div>
        </section>
      )}

      {/* Paused State Banner */}
      {isPaused && (
        <section className="active-speaker-banner is-paused-banner" aria-live="polite">
          <div className="speaker-identity-block">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--accent-warning)',
              }}
            />
            <span className="speaker-role-label" style={{ color: 'var(--accent-warning)' }}>
              SIMULATION TEMPORARILY PAUSED
            </span>
          </div>
          <div className="speaker-transcript-quote">
            Radio playback suspended. Click "Resume" to continue transmission sequence.
          </div>
        </section>
      )}

      {/* 4 Telemetry Metric Cards */}
      <section className="dashboard-metrics-grid" aria-label="Flight Telemetry">
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Radio Frequency</span>
            <Radio size={16} color="#30D158" />
          </div>
          <div className="metric-value">
            {currentScenario.frequency.split(' ')[0]}{' '}
            <span style={{ fontSize: '13px', fontWeight: 400, color: 'var(--text-secondary)' }}>
              MHz
            </span>
          </div>
          <div className="metric-footer">
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#30D158' }} />
            <span>Live ATC Tower Audio Feed</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Read-Back Compliance</span>
            <ShieldCheck size={16} color={mismatchCount > 0 ? '#FF3B30' : '#30D158'} />
          </div>
          <div
            className="metric-value"
            style={{ color: mismatchCount > 0 ? 'var(--accent-critical)' : 'inherit' }}
          >
            {complianceRate}%
          </div>
          <div className="metric-footer">
            <span>
              {mismatchCount > 0
                ? `${mismatchCount} Discrepancy Detected`
                : 'All Read-Backs Matched'}
            </span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Active Safety Alerts</span>
            <AlertTriangle
              size={16}
              color={activeAlerts.length > 0 ? '#FF3B30' : 'var(--text-tertiary)'}
            />
          </div>
          <div
            className="metric-value"
            style={{ color: activeAlerts.length > 0 ? 'var(--accent-critical)' : 'inherit' }}
          >
            {activeAlerts.length}{' '}
            <span style={{ fontSize: '13px', fontWeight: 400, color: 'var(--text-secondary)' }}>
              {activeAlerts.length === 1 ? 'Alert' : 'Alerts'}
            </span>
          </div>
          <div className="metric-footer">
            <span>
              {activeAlerts.length > 0
                ? 'Immediate controller intervention required'
                : 'Operational safety nominal'}
            </span>
          </div>
        </div>

        <div
          className="metric-card"
          style={{
            borderColor: dbStatus === 'error' ? 'var(--accent-critical-border)' : undefined,
          }}
        >
          <div className="metric-header">
            <span className="metric-title">Cloud Synchronization</span>
            <Database
              size={16}
              color={
                dbStatus === 'error'
                  ? '#FF3B30'
                  : dbStatus === 'connected'
                  ? '#30D158'
                  : '#0071E3'
              }
            />
          </div>
          <div
            className="metric-value"
            style={{
              fontSize: '20px',
              color: dbStatus === 'error' ? 'var(--accent-critical)' : 'inherit',
            }}
          >
            {dbSyncCount}{' '}
            <span style={{ fontSize: '13px', fontWeight: 400, color: 'var(--text-secondary)' }}>
              {dbSyncCount === 1 ? 'Record Synced' : 'Records Synced'}
            </span>
          </div>
          <div className="metric-footer">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background:
                  dbStatus === 'connected'
                    ? '#30D158'
                    : dbStatus === 'error'
                    ? '#FF3B30'
                    : dbStatus === 'syncing'
                    ? '#0071E3'
                    : '#A1A1AA',
              }}
            />
            <span>
              {dbStatus === 'connected'
                ? 'Supabase Audit Ledger (Live Verified)'
                : dbStatus === 'syncing'
                ? 'Writing to Supabase...'
                : dbStatus === 'error'
                ? `Sync Alert: ${lastDbError || 'Write failed'}`
                : 'Supabase Audit Ledger Standby'}
            </span>
          </div>
          {dbStatus === 'error' && lastDbError && (
            <div
              style={{
                marginTop: 8,
                padding: '6px 8px',
                borderRadius: 4,
                background: 'var(--accent-critical-bg)',
                border: '1px solid var(--accent-critical-border)',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--accent-critical)',
                lineHeight: 1.3,
                wordBreak: 'break-word',
              }}
            >
              {lastDbError.includes('permission denied')
                ? 'Notice: Table permissions missing. Run supabase/migrations/002_fix_rls_and_permissions.sql in Supabase SQL editor.'
                : lastDbError}
            </div>
          )}
        </div>
      </section>

      {/* Main Operations Split Workspace */}
      <div className="dashboard-workspace-grid">
        {/* Left Column: Live Radio Transcript Stream */}
        <section className="transcript-panel" aria-label="Live Transcript Panel">
          <div className="panel-header">
            <div className="panel-title-group">
              <Volume2 size={16} />
              <h2 className="panel-title">Live Radio Transcript & ASR Feed</h2>
            </div>
            <span className="panel-badge">
              {totalCount} {totalCount === 1 ? 'TRANSMISSION' : 'TRANSMISSIONS'}
            </span>
          </div>

          <div className="transcript-stream-list">
            {displayedLines.length === 0 ? (
              <div className="empty-standby-box">
                <div className="empty-standby-icon">
                  <Radio size={24} />
                </div>
                <h3
                  style={{
                    fontSize: '15px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    marginBottom: 6,
                  }}
                >
                  Radio Frequency Standby
                </h3>
                <p
                  style={{
                    fontSize: '13px',
                    color: 'var(--text-secondary)',
                    maxWidth: 400,
                    lineHeight: 1.5,
                  }}
                >
                  Click <strong>"Play Scenario"</strong> above to stream the scripted exchange.
                  Speech recognition, Web Speech voice playback, and LLM instruction extraction will
                  parse each clearance in real time.
                </p>
              </div>
            ) : (
              displayedLines.map((line) => (
                <article
                  key={line.id}
                  className={`transcript-card ${
                    line.role === 'controller' ? 'is-controller' : 'is-pilot'
                  }`}
                >
                  <div className="transcript-card-meta">
                    <span
                      className={`transcript-speaker-badge ${
                        line.role === 'controller' ? 'controller' : 'pilot'
                      }`}
                    >
                      {line.role === 'controller' ? 'ATC CONTROLLER' : 'FLIGHT CREW'} ·{' '}
                      {line.speaker}
                    </span>
                    <span className="transcript-timestamp">{line.timestamp}</span>
                  </div>

                  <div className="transcript-text">{line.text}</div>

                  {/* Extracted Parameters Bar with Discrepancy Highlighting */}
                  {line.isExtracting ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-tertiary)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          border: '2px solid var(--text-tertiary)',
                          borderTopColor: 'transparent',
                          borderRadius: '50%',
                          animation: 'safecomm-spin 0.8s linear infinite',
                        }}
                      />
                      <span>PARSING AERONAUTICAL NLU PARAMETERS...</span>
                    </div>
                  ) : line.extraction ? (
                    <div className="transcript-extracted-bar">
                      <span className="extracted-chip callsign">✈ {line.extraction.callsign}</span>

                      {line.extraction.instructions.map((inst, idx) => {
                        // Highlight field if pilot read-back has a mismatch for this type or direction
                        const isMismatched = line.verdict?.mismatchedFields.some(
                          (mf) =>
                            mf.toLowerCase().includes(inst.type.toLowerCase()) ||
                            (inst.direction &&
                              mf.toLowerCase().includes(inst.direction.toLowerCase()))
                        );

                        return (
                          <span
                            key={idx}
                            className={`extracted-chip ${
                              isMismatched ? 'mismatched-field-chip' : ''
                            }`}
                            title={
                              isMismatched
                                ? 'Detected discrepancy with ATC clearance'
                                : undefined
                            }
                          >
                            <strong>{inst.type.toUpperCase()}:</strong>{' '}
                            {inst.action ? `${inst.action} ` : ''}
                            {inst.direction ? `${inst.direction} ` : ''}
                            {inst.value}
                            {isMismatched && ' ⚠'}
                          </span>
                        );
                      })}

                      <span className="extracted-chip parser-tag">
                        via {line.extraction.parserType}
                      </span>
                    </div>
                  ) : null}

                  {/* Inline Verification Chip for Pilot Read-Backs */}
                  {line.verdict && (
                    <div
                      className={`inline-verdict-chip ${
                        line.verdict.outcome === 'MATCH' ? 'match' : 'mismatch'
                      }`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {line.verdict.outcome === 'MATCH' ? (
                          <CheckCircle2 size={16} />
                        ) : (
                          <XCircle size={16} />
                        )}
                        <span>
                          {line.verdict.outcome === 'MATCH'
                            ? 'READ-BACK VERIFIED: 100% PHRASEOLOGY MATCH'
                            : `READ-BACK DEVIATION DETECTED: ${line.verdict.explanation}`}
                        </span>
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          textTransform: 'uppercase',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {line.verdict.severity}
                      </span>
                    </div>
                  )}
                </article>
              ))
            )}
            <div ref={transcriptBottomRef} />
          </div>
        </section>

        {/* Right Column: Active Alerts, Phraseology Inspector, and Training Guidance */}
        <div className="dashboard-right-column">
          {/* Simulated Training Advisory Card (Appears on Mismatch) */}
          {activeCorrection && (
            <section
              className="training-advisory-card"
              aria-label="Simulated Training Correction"
            >
              <div className="training-advisory-header">
                <div className="training-advisory-title">
                  <ShieldCheck size={16} color="#FF9F0A" />
                  <span>SafeComm Simulated Training Guidance</span>
                </div>
                <span className="training-disclaimer-pill">Simulated Training Audio</span>
              </div>

              <div className="training-advisory-body">
                <div className="training-deviation-headline">
                  {activeCorrection.deviationTitle}
                </div>

                <div className="training-speech-bubble">
                  <div className="speech-bubble-header">
                    <Volume2 size={13} color="#0071E3" />
                    <span>SafeComm Spoken Correction Guidance</span>
                  </div>
                  <p className="speech-bubble-text">"{activeCorrection.spokenGuidance}"</p>
                </div>

                {activeCorrection.mismatchedFields.length > 0 && (
                  <div className="training-fields-box">
                    <span className="training-fields-label">Highlighted Conflict Fields:</span>
                    <div className="training-fields-list">
                      {activeCorrection.mismatchedFields.map((field, idx) => (
                        <span key={idx} className="training-field-tag">
                          ⚠ {field}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Trainee Corrected Response Feedback */}
                {activeCorrection.retryCompleted && (
                  <div className="trainee-confirmed-box">
                    <div className="trainee-confirmed-header">
                      <CheckCircle2 size={14} color="#30D158" />
                      <span>Trainee Corrected Read-Back Rehearsed:</span>
                    </div>
                    <div className="trainee-confirmed-quote">
                      "{activeCorrection.scriptedCorrectedReadback}"
                    </div>
                    <div className="trainee-confirmed-note">
                      Simulated practice read-back preview. Original scenario data preserved without
                      database duplication.
                    </div>
                  </div>
                )}

                {/* Interactive Action Buttons */}
                <div className="training-buttons-row">
                  <button
                    type="button"
                    className="training-btn-replay"
                    onClick={handleReplayCorrection}
                    disabled={
                      activeCorrection.replayingCorrection || activeCorrection.retryingReadback
                    }
                    title="Replay simulated SafeComm spoken correction"
                  >
                    <RotateCcw size={13} />
                    <span>
                      {activeCorrection.replayingCorrection
                        ? 'Broadcasting...'
                        : 'Replay Correction'}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="training-btn-retry"
                    onClick={handleRepeatCorrectedReadback}
                    disabled={
                      activeCorrection.replayingCorrection || activeCorrection.retryingReadback
                    }
                    title="Speak scripted corrected pilot read-back"
                  >
                    <Play size={13} fill="currentColor" />
                    <span>
                      {activeCorrection.retryingReadback
                        ? 'Transmitting...'
                        : 'Repeat Corrected Read-Back'}
                    </span>
                  </button>
                </div>

                <div className="training-legal-footer">
                  Simulated training guidance for flight crew phraseology rehearsal. Not certified
                  operational aviation instructions.
                </div>
              </div>
            </section>
          )}

          {/* Active Alerts Panel */}
          <section className="inspector-card" aria-label="Active Safety Alerts">
            <div className="inspector-header">
              <div className="inspector-title">
                <AlertTriangle
                  size={16}
                  color={activeAlerts.length > 0 ? '#FF3B30' : 'var(--text-tertiary)'}
                />
                <span>Active Safety Alerts</span>
              </div>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  fontFamily: 'var(--font-mono)',
                  color:
                    activeAlerts.length > 0
                      ? 'var(--accent-critical)'
                      : 'var(--text-tertiary)',
                }}
              >
                {activeAlerts.length} UNACKNOWLEDGED
              </span>
            </div>

            {activeAlerts.length === 0 ? (
              <div className="empty-standby-box" style={{ padding: '24px 16px' }}>
                <CheckCircle2 size={24} color="#30D158" style={{ marginBottom: 8 }} />
                <div
                  style={{
                    fontSize: '13.5px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}
                >
                  Zero Safety Incursions
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: 2 }}>
                  All pilot read-backs strictly conform to controller instructions.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {activeAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`alert-item-card ${
                      alert.severity === 'CRITICAL' ? 'critical' : 'warning'
                    }`}
                  >
                    <div className="alert-item-header">
                      <span
                        className={`alert-severity-pill ${
                          alert.severity === 'CRITICAL' ? 'critical' : 'warning'
                        }`}
                      >
                        {alert.headline}
                      </span>
                      <span className="alert-time">{alert.timestamp}</span>
                    </div>
                    <div className="alert-desc">{alert.explanation}</div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginTop: 4,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        AIRCRAFT: {alert.callsign}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setActiveAlerts((prev) => prev.filter((a) => a.id !== alert.id))
                        }
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '3px 8px',
                          borderRadius: 4,
                          background: 'var(--bg-base)',
                          border: '1px solid var(--border-medium)',
                          cursor: 'pointer',
                          color: 'var(--text-primary)',
                        }}
                      >
                        Acknowledge
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Real-Time Phraseology Inspector */}
          <section className="inspector-card" aria-label="Phraseology Inspector">
            <div className="inspector-header">
              <div className="inspector-title">
                <Sparkles size={16} color="#0071E3" />
                <span>Deterministic Phraseology Comparison</span>
              </div>
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-tertiary)',
                }}
              >
                FAA 7110.65
              </span>
            </div>

            {!lastComparison ? (
              <div className="empty-standby-box" style={{ padding: '24px 16px' }}>
                <Plane size={24} style={{ marginBottom: 8 }} />
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Awaiting clearance and read-back exchange to perform deterministic parameter
                  diff.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {/* Controller Assigned */}
                  <div
                    style={{
                      background: 'var(--bg-subtle)',
                      border: '1px solid var(--border-hairline)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 12,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: '#0071E3',
                        marginBottom: 6,
                      }}
                    >
                      ATC Clearance Assigned
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <div>Callsign: {lastComparison.controllerExt.callsign}</div>
                      {lastComparison.controllerExt.instructions.map((inst, i) => (
                        <div key={i} style={{ marginTop: 2 }}>
                          • {inst.type}: {inst.action || ''} {inst.direction || ''} {inst.value}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Pilot Read Back */}
                  <div
                    style={{
                      background: 'var(--bg-subtle)',
                      border: '1px solid var(--border-hairline)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 12,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--text-primary)',
                        marginBottom: 6,
                      }}
                    >
                      Flight Crew Read-Back
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <div>Callsign: {lastComparison.pilotExt.callsign}</div>
                      {lastComparison.pilotExt.instructions.map((inst, i) => (
                        <div key={i} style={{ marginTop: 2 }}>
                          • {inst.type}: {inst.action || ''} {inst.direction || ''} {inst.value}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Match / Mismatch Highlights */}
                <div
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background:
                      lastComparison.verdict.outcome === 'MATCH'
                        ? 'rgba(48, 209, 88, 0.08)'
                        : 'rgba(255, 59, 48, 0.08)',
                    border: `1px solid ${
                      lastComparison.verdict.outcome === 'MATCH'
                        ? 'rgba(48, 209, 88, 0.25)'
                        : 'rgba(255, 59, 48, 0.25)'
                    }`,
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      marginBottom: 4,
                      color:
                        lastComparison.verdict.outcome === 'MATCH'
                          ? '#107C41'
                          : 'var(--accent-critical)',
                    }}
                  >
                    {lastComparison.verdict.outcome === 'MATCH'
                      ? '✓ All Instruction Parameters Verified'
                      : '⚠ Read-Back Conflicts Detected'}
                  </div>
                  {lastComparison.verdict.mismatchedFields.map((f, i) => (
                    <div
                      key={i}
                      style={{
                        color: 'var(--accent-critical)',
                        fontSize: 11.5,
                        fontWeight: 600,
                      }}
                    >
                      ✗ {f}
                    </div>
                  ))}
                  {lastComparison.verdict.matchedFields.map((f, i) => (
                    <div key={i} style={{ color: '#107C41', fontSize: 11.5 }}>
                      ✓ {f}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Connected Session Status */}
          <section className="inspector-card" style={{ padding: '14px 18px' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div
                  style={{ width: 8, height: 8, borderRadius: '50%', background: '#30D158' }}
                />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                  Active Officer: {user?.email?.split('@')[0] || 'KSFO Tower'}
                </span>
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-tertiary)',
                }}
              >
                {activeSessionId ? activeSessionId.slice(0, 18) + '...' : 'READY'}
              </span>
            </div>
          </section>
        </div>
      </div>

      {/* Shared ATC & Pilot Communication Room Modal */}
      <CommRoomModal
        isOpen={isCommModalOpen}
        onClose={() => setIsCommModalOpen(false)}
      />
    </div>
  );
};
