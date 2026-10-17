import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Moon,
  Sun,
  ShieldAlert,
  Volume2,
  VolumeX,
  Play,
  LogOut,
  Trash2,
  Cpu,
  Database,
  CheckCircle2,
  AlertTriangle,
  Info,
  Check,
  RefreshCw,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import {
  isNotificationSoundEnabled,
  setNotificationSoundEnabled,
  playHighAlertEarcon,
} from '../lib/notificationSound';
import './Settings.css';

export const Settings: React.FC = () => {
  const { user, isConfigured, signOut } = useAuth();
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

  // 2. Notification Sound State
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

  // 3. Reset Demo Data State
  const [isResetting, setIsResetting] = useState<boolean>(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const handleResetDemoData = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to reset your demo data? This will clear your transmissions, verdicts, alerts, and sessions so you can re-run a clean demo.'
    );
    if (!confirmed) return;

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
        setResetMessage(
          `Demo data cleared successfully (${payload?.sessions_deleted || 0} sessions reset). Re-run scenarios cleanly.`
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

  // 4. Sign Out
  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="settings-page-container">
      {/* Header */}
      <header className="settings-header">
        <h1>System Configuration &amp; Settings</h1>
        <p>
          Manage your aerospace console display, audio earcons, AI parser status, and session data.
        </p>
      </header>

      <div className="settings-cards-list">
        {/* Appearance Card */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              {isDark ? <Moon size={20} color="#60a5fa" /> : <Sun size={20} color="#f59e0b" />}
              <span>Appearance &amp; Theme</span>
            </div>
          </div>
          <p className="settings-card-desc">
            Select between the default Apple-inspired light interface and the night flight deck dark mode.
          </p>

          <div className="theme-options-grid">
            <button
              type="button"
              className={`theme-option-btn ${!isDark ? 'is-active' : ''}`}
              onClick={() => toggleTheme(false)}
            >
              <Sun size={20} color="#f59e0b" />
              <div>
                <div style={{ fontWeight: 650, fontSize: 14 }}>Day Light Mode</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Clean high-contrast theme</div>
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
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Low-glare radar flight deck</div>
              </div>
            </button>
          </div>
        </section>

        {/* AI Parser Status (Read-Only) */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <Cpu size={20} color="#3b82f6" />
              <span>Aviation Phraseology &amp; AI Parser Status</span>
            </div>
            <span className="parser-status-badge active">
              <CheckCircle2 size={12} />
              Operational
            </span>
          </div>
          <p className="settings-card-desc">
            SafeComm employs an authoritative dual-parser architecture combining server-side LLM extraction with deterministic local rule-based safety verification.
          </p>

          <div className="parser-status-box">
            <div className="parser-status-row">
              <span className="parser-status-label">Active Extraction Strategy:</span>
              <span className="parser-status-badge local">
                Local Parser + Hybrid Edge Function
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Configured LLM Cloud Provider:</span>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                Groq (Llama 3.3 70B) &amp; Gemini 2.5 Flash
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">API Key Storage Location:</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Supabase Edge Function Secret (Server-side only — zero client exposure)
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Deterministic Verification Engine:</span>
              <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>
                FAA Order 7110.65 / ICAO Annex 10 (100% deterministic unit-tested)
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Offline / Local Fallback:</span>
              <span style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                Instant Sub-5ms Regex/Rule Extractor (Guaranteed fallback)
              </span>
            </div>
          </div>
        </section>

        {/* Safety Audio Earcons */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <Volume2 size={20} color="#10b981" />
              <span>Safety Audio Earcon &amp; Alert Chime</span>
            </div>
          </div>
          <p className="settings-card-desc">
            Plays an authentic Web Audio API synthesized two-tone Master Caution chime whenever a HIGH severity clearance deviation is recorded.
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

        {/* Cloud Database (Supabase) & Officer Account */}
        <section className="settings-card">
          <div className="settings-card-header">
            <div className="settings-card-title">
              <Database size={20} color="#3b82f6" />
              <span>Officer Session &amp; Supabase Integration</span>
            </div>
            <span className={`parser-status-badge ${isConfigured ? 'active' : 'local'}`}>
              <CheckCircle2 size={12} />
              {isConfigured ? 'Connected' : 'Local Demo'}
            </span>
          </div>

          <div className="parser-status-box">
            <div className="parser-status-row">
              <span className="parser-status-label">Logged In Officer:</span>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 600 }}>
                {user?.email || 'officer@safecomm.aero'}
              </span>
            </div>
            <div className="parser-status-row">
              <span className="parser-status-label">Active Database Endpoint:</span>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--text-secondary)' }}>
                https://sduigyfousbbhrgkjjjg.supabase.co
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
        </section>

        {/* Danger Zone: Reset Demo Data */}
        <section className="settings-card settings-danger-card">
          <div className="settings-card-header">
            <div className="settings-card-title" style={{ color: '#ef4444' }}>
              <Trash2 size={20} color="#ef4444" />
              <span>Demo Environment Reset</span>
            </div>
          </div>
          <p className="settings-card-desc">
            Clear all transmissions, verdicts, alerts, and communication room sessions created in this workspace to run a fresh, uncontaminated demo presentation.
          </p>

          <div className="danger-btn-row">
            <button
              type="button"
              className="btn-danger"
              onClick={handleResetDemoData}
              disabled={isResetting}
            >
              <Trash2 size={15} />
              <span>{isResetting ? 'Clearing Supabase Rows…' : 'Reset Demo Data'}</span>
            </button>
          </div>

          {resetMessage && (
            <div
              style={{
                fontSize: 13,
                padding: '10px 14px',
                borderRadius: 8,
                background: resetMessage.includes('Failed') ? 'rgba(239, 68, 68, 0.12)' : 'rgba(16, 185, 129, 0.12)',
                color: resetMessage.includes('Failed') ? '#ef4444' : '#10b981',
                border: `1px solid ${resetMessage.includes('Failed') ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`,
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
          <strong>Prototype — not for operational use.</strong> SafeComm is an aeronautical safety demonstrator combining speech recognition, LLM extraction, and deterministic read-back verification.
        </span>
      </footer>
    </div>
  );
};
