import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import {
  Eye,
  EyeOff,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Radio,
  Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './Login.css';

export const Login: React.FC = () => {
  const { user, signIn, signUp, signInDemo, signInWithOAuth, isConfigured } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/dashboard';

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // If already authenticated, redirect to destination
  useEffect(() => {
    if (user) {
      navigate(from, { replace: true });
    }
  }, [user, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!email || !password) {
      setErrorMsg('Please enter both email and password.');
      return;
    }

    if (password.length < 6) {
      setErrorMsg('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);

    try {
      if (mode === 'signin') {
        const { error } = await signIn(email, password);
        if (error) {
          setErrorMsg(error.message);
        } else {
          navigate(from, { replace: true });
        }
      } else {
        const { error, data } = await signUp(email, password);
        if (error) {
          if (error.message.includes('rate limit')) {
            setErrorMsg(
              'Supabase free-tier email rate limit reached (max 3 emails/hour). You can use the Quick Demo Sign-In button below or disable "Confirm email" in Supabase Auth settings.'
            );
          } else {
            setErrorMsg(error.message);
          }
        } else {
          if (data?.session) {
            navigate(from, { replace: true });
          } else {
            setSuccessMsg('Account registered! If confirmation is required, check your email or sign in directly.');
            setMode('signin');
          }
        }
      }
    } catch (err: unknown) {
      setErrorMsg((err as Error).message || 'An unexpected authentication error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const handleDemoSignIn = () => {
    signInDemo('officer.ksfo@safecomm.aero');
    navigate(from, { replace: true });
  };

  const handleOAuth = async (provider: 'google' | 'github') => {
    setErrorMsg(null);
    try {
      const { error } = await signInWithOAuth(provider);
      if (error) {
        setErrorMsg(`OAuth (${provider}) requires redirect configuration in Supabase: ${error.message}`);
      }
    } catch (err: unknown) {
      setErrorMsg((err as Error).message);
    }
  };

  return (
    <div className="login-page-container">
      {/* Left Aerospace Hero Panel */}
      <div className="login-hero-panel">
        <div className="login-hero-bg-grid" />
        <div className="login-hero-radar-glow" />

        <div className="login-hero-header">
          <Link to="/" className="login-hero-brand">
            <img src="/src/assets/logo-icon.svg" alt="SafeComm" />
            <span className="login-hero-brand-name">SafeComm</span>
          </Link>

          <div className="login-hero-status-pill">
            <Radio size={12} color="#30D158" />
            <span>TOWER 121.700 MHz</span>
          </div>
        </div>

        <div className="login-hero-main-content">
          <h1 className="login-hero-headline">
            Every Read-Back.
            <span>Verified.</span>
          </h1>

          <p className="login-hero-desc">
            Aeronautical intelligence and sub-second deterministic phraseology verification.
            Prevent runway incursions and altitude deviations across high-consequence operations.
          </p>

          <div className="login-hero-highlights">
            <div className="login-highlight-row">
              <span className="login-highlight-bullet" />
              <span>Real-time ASR & NLU extraction on controller-pilot dialogues</span>
            </div>
            <div className="login-highlight-row">
              <span className="login-highlight-bullet" />
              <span>FAA Order 7110.65 & ICAO Annex 10 phraseology rules</span>
            </div>
            <div className="login-highlight-row">
              <span className="login-highlight-bullet" />
              <span>Immutable cryptographic safety ledger backed by Supabase</span>
            </div>
          </div>
        </div>

        <div className="login-hero-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ShieldCheck size={14} color="#30D158" />
            <span>FAA / ICAO COMPLIANCE ENGINE · V2.4</span>
          </div>
          <span>UTC TIME ZULU</span>
        </div>
      </div>

      {/* Right Login / Sign-up Form Panel */}
      <div className="login-form-panel">
        <div className="login-form-card">
          <div className="login-card-header">
            <h2 className="login-card-title">
              {mode === 'signin' ? 'Sign In to SafeComm' : 'Create Officer Account'}
            </h2>
            <p className="login-card-subtitle">
              {mode === 'signin'
                ? 'Enter your flight operations credentials to access the safety console.'
                : 'Register an account to monitor and verify live ATC communications.'}
            </p>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="login-mode-tabs">
            <button
              type="button"
              className={`login-tab-btn ${mode === 'signin' ? 'is-active' : ''}`}
              onClick={() => {
                setMode('signin');
                setErrorMsg(null);
                setSuccessMsg(null);
              }}
            >
              Sign In
            </button>
            <button
              type="button"
              className={`login-tab-btn ${mode === 'signup' ? 'is-active' : ''}`}
              onClick={() => {
                setMode('signup');
                setErrorMsg(null);
                setSuccessMsg(null);
              }}
            >
              Create Account
            </button>
          </div>

          {/* Feedback Banners */}
          {errorMsg && (
            <div className="login-alert is-error" role="alert" style={{ marginBottom: 16 }}>
              <AlertCircle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="login-alert is-success" role="status" style={{ marginBottom: 16 }}>
              <CheckCircle2 size={16} />
              <span>{successMsg}</span>
            </div>
          )}

          {!isConfigured && (
            <div className="login-alert is-error" style={{ marginBottom: 16 }}>
              <AlertCircle size={16} />
              <span>Supabase credentials not configured in .env</span>
            </div>
          )}

          {/* Form */}
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label" htmlFor="email-input">
                ATC Officer Email
              </label>
              <div className="form-input-wrapper">
                <input
                  id="email-input"
                  type="email"
                  className="form-input"
                  placeholder="officer@tower.faa.gov"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="password-input">
                <span>Password</span>
                {mode === 'signin' && (
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                    Min 6 characters
                  </span>
                )}
              </label>
              <div className="form-input-wrapper">
                <input
                  id="password-input"
                  type={showPassword ? 'text' : 'password'}
                  className="form-input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  required
                />
                <button
                  type="button"
                  className="form-input-toggle"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="login-submit-btn"
              disabled={loading}
            >
              {loading ? (
                <div
                  style={{
                    width: 16,
                    height: 16,
                    border: '2px solid rgba(255, 255, 255, 0.4)',
                    borderTopColor: '#FFF',
                    borderRadius: '50%',
                    animation: 'safecomm-spin 0.8s linear infinite',
                  }}
                />
              ) : mode === 'signin' ? (
                'Sign In'
              ) : (
                'Create Account'
              )}
            </button>
          </form>

          {/* Quick Demo Officer Login Button */}
          <div style={{ marginTop: '12px' }}>
            <button
              type="button"
              onClick={handleDemoSignIn}
              style={{
                width: '100%',
                height: '40px',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-medium)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              title="Sign in immediately as a pre-configured ATC officer"
            >
              <Zap size={15} color="#FF9F0A" />
              <span>Quick Demo Sign-In (Officer KSFO-01)</span>
            </button>
          </div>

          {/* OAuth Divider */}
          <div className="login-divider">
            <span className="login-divider-text">Or continue with</span>
          </div>

          {/* OAuth Buttons */}
          <div className="oauth-grid">
            <button
              type="button"
              className="oauth-btn"
              onClick={() => handleOAuth('google')}
              title="Sign in with Google OAuth"
            >
              <svg viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Google</span>
            </button>

            <button
              type="button"
              className="oauth-btn"
              onClick={() => handleOAuth('github')}
              title="Sign in with GitHub OAuth"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span>GitHub</span>
            </button>
          </div>

          <Link to="/" className="login-return-link">
            <ArrowLeft size={14} />
            <span>Return to SafeComm overview</span>
          </Link>
        </div>
      </div>
    </div>
  );
};
