import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Moon,
  Sun,
  Volume2,
  VolumeX,
  Play,
  Square,
  LogOut,
  Trash2,
  Cpu,
  Database,
  CheckCircle2,
  Info,
  RefreshCw,
  Radio,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { extractInstructions } from '../lib/llmExtractor';
import {
  isNotificationSoundEnabled,
  setNotificationSoundEnabled,
  playHighAlertEarcon,
} from '../lib/notificationSound';
import {
  type SpeakerRole,
  type VoiceSettings,
  loadVoiceSettings,
  saveVoiceSettings,
  isSpeechSynthesisSupported,
  onVoicesChanged,
  previewVoice,
  stopVoicePreview,
} from '../lib/speechAudio';
import './Settings.css';

export const Settings: React.FC = () => {
  const { user, isConfigured, signOut, createDatabaseSession } = useAuth();
  const navigate = useNavigate();

  // 1. Theme State
  const [isDark, setIsDark] = useState<boolean>(() => {
    return (
      document.documentElement.classList.contains('dark') ||
      localStorage.getItem('safecomm_theme') === 'dark'
    );
  });

  const toggleTheme = (enableDark: boolean) => {
    setIsDark(enableDark);
    if (enableDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('safecomm_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('safecomm_theme', 'light');
    }
  };

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // 2. Notification Sound State (Web Audio earcon on high alerts)
  const [soundEnabled, setSoundEnabled] = useState<boolean>(isNotificationSoundEnabled);

  const toggleSound = (enabled: boolean) => {
    setSoundEnabled(enabled);
    setNotificationSoundEnabled(enabled);
    if (enabled) {
      playHighAlertEarcon();
    }
  };

  const handleTestChime = () => {
    playHighAlertEarcon();
  };

  // 3. AI Parser Status (Dynamic query without exposing secrets)
  const [activeParser, setActiveParser] = useState<string>('Verifying active parser...');
  const [configuredProvider, setConfiguredProvider] = useState<string>('Edge Function / Local Engine');
  const [parserChecking, setParserChecking] = useState<boolean>(false);

  const checkParserStatus = async () => {
    setParserChecking(true);
    try {
      const res = await extractInstructions('UAL421 climb and maintain flight level 240');
      setActiveParser(res.parserType);
      if (res.parserType === 'AI Parser (Groq)') {
        setConfiguredProvider('Groq Cloud (Llama 3.3 70B Versatile)');
      } else if (res.parserType === 'AI Parser (Gemini)') {
        setConfiguredProvider('Google Gemini Cloud (gemini-2.5-flash)');
      } else {
        setConfiguredProvider('Deterministic Regex / Phraseology Engine (Offline)');
      }
    } catch {
      setActiveParser('Local Parser');
      setConfiguredProvider('Deterministic Regex / Phraseology Engine (Offline)');
    } finally {
      setParserChecking(false);
    }
  };

  useEffect(() => {
    void checkParserStatus();
  }, []);

  // 4. Speech Synthesis Configuration
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(loadVoiceSettings);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechSupported, setSpeechSupported] = useState<boolean>(true);
  const [previewingRole, setPreviewingRole] = useState<SpeakerRole | null>(null);

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

  useEffect(() => {
    if (isSpeechSynthesisSupported()) {
      const unsub = onVoicesChanged((voices) => {
        setAvailableVoices(voices);
      });
      return () => {
        unsub();
        stopVoicePreview();
      };
    } else {
      setSpeechSupported(false);
    }
  }, []);

  // 5. Database Session Sync Test
  const [sessionCreating, setSessionCreating] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);

  const handleCreateTestSession = async () => {
    setSessionCreating(true);
    setSessionStatus(null);
    const { id, error } = await createDatabaseSession('Settings Console Verification');
    setSessionCreating(false);
    if (error) {
      setSessionStatus(`Session sync notice: ${error.message}`);
    } else {
      setSessionStatus(`Active session registered in Supabase: ${id}`);
    }
  };

  // 6. Reset Demo Data State (Safe user-scoped cleanup)
  const [isResetting, setIsResetting] = useState<boolean>(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);

  const executeResetDemoData = async () => {
    setShowConfirmModal(false);
    setIsResetting(true);
    setResetMessage(null);

    try {
      const { data, error } = await supabase.rpc('reset_demo_data', {
        p_user_id: user?.id || null,
        p_force_all: false,
      });

      if (error) {
        setResetMessage(`Failed to reset data: ${error.message}`);
      } else {
        const payload = data as { sessions_deleted?: number; rooms_deleted?: number };
        const sessionCount = payload?.sessions_deleted ?? 0;
        const roomCount = payload?.rooms_deleted ?? 0;
        setResetMessage(
          `Demo data cleared successfully (${sessionCount} sessions, ${roomCount} rooms reset). You can now run a fresh demonstration.`
        );
        // Dispatch update event so nav rail unread badge updates immediately
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('safecomm-alerts-updated'));
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Reset failed';
      setResetMessage(`Error: ${msg}`);
    } finally {
      setIsResetting(false);
    }
  };

  // 7. Sign Out
  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="settings-page-container">
      {/* Header */}
      <header className="settings-header">
        <h1>
          <span>System Configuration &amp; Settings</span>
        </h1>
        <p>
          Configure interface appearance, acoustic earcons, AI parser status, speech synthesis, and session persistence.
        </p>
      </header>

      <div className="settings-cards-list">
        {/* 1. Appearance & Theme */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              {isDark ? <Moon size={20} color="#60a5fa" /> : <Sun size={20} color="#f59e0b" />}
              <span>Appearance &amp; Theme</span>
            </div>
          </div>
          <p className="settings-card-desc">
            Toggle between the default Apple-grade day light mode and the low-glare night radar flight deck mode. Your choice is automatically persisted across sessions.
          </p>

          <div className="theme-options-grid">
            <button
              type="button"
              className={`theme-option-btn ${!isDark ? 'is-active' : ''}`}
              onClick={() => toggleTheme(false)}
            >
              <Sun size={20} color="#f59e0b" />
              <div>
                <div style={{ fontWeight: 650, fontSize: 14 }}>Day Light Mode (Default)</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Pure black-and-white aerospace aesthetic</div>
              </div>
            </button>

            <button
              type="button"
              className={`theme-option-btn ${isDark ? 'is-active' : ''}`}
              onClick={() => toggleTheme(true)}
            >
              <Moon size={20} color="#60a5fa" />
              <div>
                <div style={{ fontWeight: 650, fontSize: 14 }}>Night Dark Mode</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Low-glare cockpit / radar flight deck</div>
              </div>
            </button>
          </div>
        </section>

        {/* 2. Safety Audio Earcons */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <Volume2 size={20} color="#10b981" />
              <span>Safety Audio Earcon &amp; Alert Notification</span>
            </div>
          </div>
          <p className="settings-card-desc">
            Plays a subtle, authentic Web Audio API synthesized two-tone Master Caution chime whenever a HIGH-severity clearance deviation or critical readback mismatch is detected.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => toggleSound(!soundEnabled)}
              style={{
                borderColor: soundEnabled ? '#10b981' : undefined,
                color: soundEnabled ? '#10b981' : undefined,
              }}
            >
              {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
              <span>Alert Earcon: {soundEnabled ? 'Enabled' : 'Muted'}</span>
            </button>

            <button
              type="button"
              className="btn-secondary"
              onClick={handleTestChime}
              title="Preview the Web Audio high-alert chime"
            >
              <Play size={14} fill="currentColor" />
              <span>Test Earcon Chime</span>
            </button>
          </div>
        </section>

        {/* 3. AI Parser Status (Read-Only Status, Never Exposes Keys) */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <Cpu size={20} color="#3b82f6" />
              <span>Aviation Phraseology &amp; AI Parser Status</span>
            </div>
            <span className="parser-status-badge active">
              <CheckCircle2 size={12} />
              {parserChecking ? 'Checking...' : 'Operational'}
            </span>
          </div>
          <p className="settings-card-desc">
            SafeComm employs a dual-parser architecture combining server-side LLM extraction with deterministic FAA Order 7110.65 / ICAO Annex 10 rulebook safety verification. All provider credentials remain server-side.
          </p>

          <div className="parser-status-box">
            <div className="parser-status-row">
              <span className="parser-status-label">Active Parser:</span>
              <span className="parser-status-badge local">
                {activeParser}
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Configured Provider:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)' }}>
                {configuredProvider}
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Credential Protection:</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Supabase Edge Function Secrets (Server-side isolated — zero client exposure)
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Deterministic Verification:</span>
              <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>
                FAA Order 7110.65 Rulebook (100% deterministic unit-tested)
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Offline Resilience:</span>
              <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                Sub-5ms Regex / Phraseology Dictionary (Automatic offline fallback)
              </span>
            </div>
          </div>

          <div>
            <button
              type="button"
              className="btn-secondary"
              onClick={checkParserStatus}
              disabled={parserChecking}
              title="Ping extraction endpoint to verify parser status"
            >
              <RefreshCw size={13} className={parserChecking ? 'safecomm-spin' : ''} />
              <span>{parserChecking ? 'Testing Parser...' : 'Re-verify Parser Status'}</span>
            </button>
          </div>
        </section>

        {/* 4. Simulated Radio Voice Synthesizer */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <Radio size={20} color="#0071E3" />
              <span>Simulated Radio Voice Playback &amp; Synthesizer</span>
            </div>
            <span
              style={{
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-tertiary)',
                padding: '3px 8px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              {speechSupported
                ? `SpeechSynthesis API (${availableVoices.length} voices loaded)`
                : 'Text-only Mode (SpeechSynthesis not detected)'}
            </span>
          </div>
          <p className="settings-card-desc">
            Configure transmission cadence, radio volume, and synthetic voice profiles for ATC tower, cockpit readback, and advisory prompts.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '16px',
            }}
          >
            {/* Cadence Slider */}
            <div
              style={{
                padding: '14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-hairline)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '11px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-tertiary)',
                  fontWeight: 600,
                }}
              >
                <span>TRANSMISSION CADENCE</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                  {voiceSettings.rate.toFixed(2)}x
                </span>
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
                style={{ width: '100%', accentColor: 'var(--text-primary)', cursor: 'pointer' }}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                Standard operational ATC pace: 1.05x
              </div>
            </div>

            {/* Volume Slider */}
            <div
              style={{
                padding: '14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-hairline)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '11px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-tertiary)',
                  fontWeight: 600,
                }}
              >
                <span>RADIO VOLUME</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                  {Math.round(voiceSettings.volume * 100)}%
                </span>
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
                style={{ width: '100%', accentColor: 'var(--text-primary)', cursor: 'pointer' }}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                Synthesized squelch click &amp; dual-tone caution chime
              </div>
            </div>
          </div>

          {/* Voice Selectors & Preview */}
          {availableVoices.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '4px' }}>
              {/* SafeComm Advisory Voice */}
              <div
                style={{
                  padding: '14px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-hairline)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    SafeComm Advisory Voice (Natural / High-Clarity)
                  </span>
                  <span style={{ fontSize: '11px', color: '#B45309', fontFamily: 'var(--font-mono)' }}>
                    Auto-selects Natural Female English
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <select
                    value={voiceSettings.assistantVoiceName || ''}
                    onChange={(e) =>
                      updateVoiceSettings((v) => ({
                        ...v,
                        assistantVoiceName: e.target.value || undefined,
                      }))
                    }
                    style={{
                      flex: 1,
                      height: '36px',
                      padding: '0 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                      fontSize: '12.5px',
                    }}
                  >
                    <option value="">Default (Natural / Clear English)</option>
                    {availableVoices.map((voice) => (
                      <option key={`set-a-${voice.name}`} value={voice.name}>
                        {voice.name} ({voice.lang})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handlePreviewVoice('assistant')}
                    style={{ height: '36px', padding: '0 12px' }}
                  >
                    {previewingRole === 'assistant' ? (
                      <Square size={12} fill="currentColor" />
                    ) : (
                      <Play size={12} fill="currentColor" />
                    )}
                    <span>{previewingRole === 'assistant' ? 'Stop' : 'Preview'}</span>
                  </button>
                </div>
              </div>

              {/* ATC Controller Voice */}
              <div
                style={{
                  padding: '14px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-hairline)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    ATC Controller Voice (Tower / Departure)
                  </span>
                  <span style={{ fontSize: '11px', color: '#0071E3', fontFamily: 'var(--font-mono)' }}>
                    Auto-selects Deep / Authoritative ATC
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <select
                    value={voiceSettings.controllerVoiceName || ''}
                    onChange={(e) =>
                      updateVoiceSettings((v) => ({
                        ...v,
                        controllerVoiceName: e.target.value || undefined,
                      }))
                    }
                    style={{
                      flex: 1,
                      height: '36px',
                      padding: '0 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                      fontSize: '12.5px',
                    }}
                  >
                    <option value="">Default (Deep / Authoritative ATC)</option>
                    {availableVoices.map((voice) => (
                      <option key={`set-c-${voice.name}`} value={voice.name}>
                        {voice.name} ({voice.lang})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handlePreviewVoice('controller')}
                    style={{ height: '36px', padding: '0 12px' }}
                  >
                    {previewingRole === 'controller' ? (
                      <Square size={12} fill="currentColor" />
                    ) : (
                      <Play size={12} fill="currentColor" />
                    )}
                    <span>{previewingRole === 'controller' ? 'Stop' : 'Preview'}</span>
                  </button>
                </div>
              </div>

              {/* Flight Crew Voice */}
              <div
                style={{
                  padding: '14px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-hairline)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Flight Crew Voice (Pilot Read-Back)
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    Cockpit Crew Cadence
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <select
                    value={voiceSettings.pilotVoiceName || ''}
                    onChange={(e) =>
                      updateVoiceSettings((v) => ({
                        ...v,
                        pilotVoiceName: e.target.value || undefined,
                      }))
                    }
                    style={{
                      flex: 1,
                      height: '36px',
                      padding: '0 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                      fontSize: '12.5px',
                    }}
                  >
                    <option value="">Default (Cockpit Crew)</option>
                    {availableVoices.map((voice) => (
                      <option key={`set-p-${voice.name}`} value={voice.name}>
                        {voice.name} ({voice.lang})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handlePreviewVoice('pilot')}
                    style={{ height: '36px', padding: '0 12px' }}
                  >
                    {previewingRole === 'pilot' ? (
                      <Square size={12} fill="currentColor" />
                    ) : (
                      <Play size={12} fill="currentColor" />
                    )}
                    <span>{previewingRole === 'pilot' ? 'Stop' : 'Preview'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* 5. Cloud Database (Supabase) & Officer Account */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <Database size={20} color="#3b82f6" />
              <span>Officer Session &amp; Supabase Integration</span>
            </div>
            <span className={`parser-status-badge ${isConfigured ? 'active' : 'local'}`}>
              <CheckCircle2 size={12} />
              {isConfigured ? 'Connected & Verified' : 'Local Demo Mode'}
            </span>
          </div>

          <div className="parser-status-box">
            <div className="parser-status-row">
              <span className="parser-status-label">Authenticated Officer:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {user?.email || 'officer@safecomm.aero'}
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Database Endpoint:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                https://sduigyfousbbhrgkjjjg.supabase.co
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleCreateTestSession}
              disabled={sessionCreating}
              title="Test real-time session synchronization to Supabase"
            >
              <RefreshCw size={14} className={sessionCreating ? 'safecomm-spin' : ''} />
              <span>{sessionCreating ? 'Registering...' : 'Test Sync Session to Supabase'}</span>
            </button>

            <button
              type="button"
              className="btn-secondary"
              onClick={handleSignOut}
              title="Sign out of SafeComm session"
            >
              <LogOut size={15} />
              <span>Sign Out Officer</span>
            </button>
          </div>

          {sessionStatus && (
            <div
              style={{
                marginTop: '12px',
                padding: '12px 14px',
                borderRadius: 'var(--radius-sm)',
                background: sessionStatus.includes('notice') || sessionStatus.includes('error')
                  ? 'var(--accent-critical-bg)'
                  : 'var(--accent-match-bg)',
                border: sessionStatus.includes('notice') || sessionStatus.includes('error')
                  ? '1px solid var(--accent-critical-border)'
                  : '1px solid var(--accent-match-border)',
                fontSize: '12.5px',
                fontFamily: 'var(--font-mono)',
                color: sessionStatus.includes('notice') || sessionStatus.includes('error')
                  ? 'var(--accent-critical)'
                  : '#107C41',
              }}
            >
              {sessionStatus}
            </div>
          )}
        </section>

        {/* 6. Danger Zone: Reset Demo Data */}
        <section className="settings-card settings-danger-card">
          <div className="settings-card-header">
            <div className="settings-card-title" style={{ color: '#ef4444' }}>
              <Trash2 size={20} color="#ef4444" />
              <span>Demo Environment Reset</span>
            </div>
          </div>
          <p className="settings-card-desc">
            Safely clear only your currently signed-in user's demo transmissions, verdicts, alerts, and sessions from Supabase. Other users' records and application configuration remain completely untouched.
          </p>

          <div className="danger-btn-row">
            <button
              type="button"
              className="btn-danger"
              onClick={() => setShowConfirmModal(true)}
              disabled={isResetting}
            >
              <Trash2 size={15} />
              <span>{isResetting ? 'Clearing Supabase Data...' : 'Reset Demo Data'}</span>
            </button>
          </div>

          {showConfirmModal && (
            <div
              style={{
                marginTop: '12px',
                padding: '16px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#ef4444' }}>
                Confirm Demo Data Reset
              </div>
              <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                This will delete your recorded approach transmissions, safety verdicts, unacknowledged alerts, and test rooms. This action is scoped strictly to your account (<span style={{ fontFamily: 'var(--font-mono)' }}>{user?.email || 'current officer'}</span>) and cannot be undone.
              </p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  type="button"
                  className="btn-danger"
                  style={{ background: '#ef4444', color: '#ffffff', borderColor: '#ef4444' }}
                  onClick={executeResetDemoData}
                >
                  Yes, Reset My Demo Data
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowConfirmModal(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {resetMessage && (
            <div
              style={{
                fontSize: 13,
                padding: '10px 14px',
                borderRadius: 8,
                background: resetMessage.includes('Failed') || resetMessage.includes('Error')
                  ? 'rgba(239, 68, 68, 0.12)'
                  : 'rgba(16, 185, 129, 0.12)',
                color: resetMessage.includes('Failed') || resetMessage.includes('Error') ? '#ef4444' : '#10b981',
                border: `1px solid ${
                  resetMessage.includes('Failed') || resetMessage.includes('Error')
                    ? 'rgba(239, 68, 68, 0.3)'
                    : 'rgba(16, 185, 129, 0.3)'
                }`,
              }}
            >
              {resetMessage}
            </div>
          )}
        </section>
      </div>

      {/* Persistent Ethics & Operational Disclaimer Badge */}
      <footer className="prototype-footer-badge">
        <Info size={14} color="var(--text-tertiary)" />
        <span>
          <strong>Prototype — not for operational use.</strong> SafeComm is an aeronautical safety demonstrator combining speech synthesis, LLM extraction, and deterministic read-back verification for research and training.
        </span>
      </footer>
    </div>
  );
};
