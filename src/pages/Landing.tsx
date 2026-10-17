import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus,
  Radio,
  ShieldCheck,
  AlertTriangle,
  ArrowRight,
  Compass,
  TrendingUp,
  MapPin,
  CheckCircle2,
  Cpu,
  Layers,
  ExternalLink,
} from 'lucide-react';
import { RadarHeroBackground } from '../components/ui/RadarHeroBackground';
import './Landing.css';

const easeAerospace: [number, number, number, number] = [0.16, 1, 0.3, 1];

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260508_215831_c6a8989c-d716-4d8d-8745-e972a2eec711.mp4';

interface ConsoleTab {
  id: 'dashboard' | 'ledger' | 'radar';
  label: string;
  badge: string;
  title: string;
  desc: string;
  features: string[];
  route: string;
}

const CONSOLE_TABS: ConsoleTab[] = [
  {
    id: 'dashboard',
    label: 'Live Dashboard',
    badge: '121.700 MHz',
    title: 'Real-Time Radio Ingestion & Verification Feed',
    desc: 'Simulated real-time streaming of controller transmissions and pilot read-backs with millisecond synchronization, acoustic waveforms, and inline verdict chips.',
    features: [
      'Acoustic Waveform Visualizer with VAD state',
      'Dual speaker badges: Blue-Gray Controller vs Black Pilot',
      'Instant inline safety chips: Matched / Mismatch / Flagged',
      'Right-side Active Alerts & Acoustic System Status panel',
    ],
    route: '/dashboard',
  },
  {
    id: 'ledger',
    label: 'Verification Ledger',
    badge: 'Flight Strips',
    title: 'Immutable Audit Trail & Telemetry Search',
    desc: 'Electronic flight-strip style audit ledger cataloging every instruction, read-back, outcome, and severity grade with search, status filtering, and CSV export.',
    features: [
      'Searchable by callsign, waypoint, or runway',
      'Filterable by severity (Critical / Warning / Clean)',
      'Side-by-side instruction vs heard read-back text',
      'One-click client-side export to CSV for safety audit logs',
    ],
    route: '/ledger',
  },
  {
    id: 'radar',
    label: 'Terminal Radar',
    badge: 'Scope View',
    title: 'Spatial Situational Awareness & Scope Overlay',
    desc: 'High-contrast terminal airspace radar display with range rings (10–50 NM), sweep afterglow, center runway glyphs, and selectable aircraft targets.',
    features: [
      'Dynamic range rings with NM radial distance markers',
      'Clockwise phosphor sweep line with realistic decay',
      'Simulated target blips with callsign, flight level & heading vectors',
      'Interactive target inspector panel with last instruction & verdict',
    ],
    route: '/map',
  },
];

export const Landing: React.FC = () => {
  const navigate = useNavigate();
  const [systemsOpen, setSystemsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'ledger' | 'radar'>('dashboard');
  const [isScrolled, setIsScrolled] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Close systems menu on Escape key or outside click, and track scroll
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSystemsOpen(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (!target.closest('.systems-pill')) {
          setSystemsOpen(false);
        }
      }
    };
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 40);
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const scrollToFeatures = () => {
    const featuresEl = document.getElementById('features');
    if (featuresEl) {
      featuresEl.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const currentConsoleTab = CONSOLE_TABS.find((t) => t.id === activeTab) || CONSOLE_TABS[0];

  return (
    <div className="landing-container">
      {/* ===================================================================
          HERO SECTION (Video + Subtle Radar Layer)
          =================================================================== */}
      <section className="hero-section">
        {/* Layer 1: Subtle Aerospace Radar Background (z-index: 0) */}
        <div className="hero-radar-layer">
          <RadarHeroBackground theme="light" opacity={0.95} />
        </div>

        {/* Layer 2: Motion.dev Primary Video (z-index: 10) */}
        <motion.div
          className="video-wrapper"
          initial={{ opacity: 0, scale: 1.05 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.8, ease: easeAerospace }}
        >
          <video
            className="hero-video"
            src={VIDEO_URL}
            autoPlay
            muted
            loop
            playsInline
          />
        </motion.div>

        {/* Layer 3: Fixed Top Navbar (z-index: 50) */}
        <motion.nav
          className={`fixed-navbar ${isScrolled ? 'is-scrolled' : ''}`}
          initial={{ y: -16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.8, ease: easeAerospace }}
        >
          {/* Left: Logo + Systems + Tags */}
          <div className="nav-left">
            <Link to="/" className="nav-logo-group" aria-label="SafeComm Homepage">
              <svg width="22" height="22" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14.5 7C10.5 7 7.5 10.2 7.5 14.5C7.5 18.8 10.2 21.2 13.8 23.2C17.5 25.2 20.2 27 20.2 30.5C20.2 33.8 17.5 36 13.8 36C10.2 36 7.8 33.5 7.5 30.2L4 30.5C4.5 35.8 8.5 39.5 13.8 39.5C19.5 39.5 23.8 35.5 23.8 30.2C23.8 25.5 20.5 22.8 16.5 20.5C13 18.5 11 16.8 11 14.2C11 11.5 13 9.8 15.5 9.8C18.2 9.8 20.2 11.8 20.8 14.8L24.2 14.2C23.2 9.8 19.5 7 14.5 7Z" fill="#0A0A0A"/>
                <path d="M27.2 4.5L28.8 4.5L29.3 8.2L34.5 11.2V12.8L29.3 11.2L29.1 15.5L31.2 17.2V18.2L28 17.5L24.8 18.2V17.2L26.9 15.5L26.7 11.2L21.5 12.8V11.2L26.7 8.2L27.2 4.5Z" fill="#0A0A0A"/>
                <rect x="23" y="24" width="2" height="12" rx="1" fill="#0A0A0A"/>
                <rect x="26.5" y="21" width="2" height="15" rx="1" fill="#0A0A0A"/>
                <rect x="30" y="19" width="2" height="17" rx="1" fill="#0A0A0A"/>
                <rect x="33.5" y="22" width="2" height="14" rx="1" fill="#0A0A0A"/>
                <rect x="37" y="26" width="2" height="10" rx="1" fill="#0A0A0A"/>
              </svg>
              <span className="nav-brand-text">SafeComm</span>
            </Link>

            {/* Systems Pill (Replaces generic "Menu") */}
            <button
              className="systems-pill"
              onClick={() => setSystemsOpen(!systemsOpen)}
              aria-expanded={systemsOpen}
              aria-haspopup="menu"
              aria-label="Toggle Systems Navigation"
            >
              <div className="systems-icon-circle">
                <Plus size={13} strokeWidth={2.75} />
              </div>
              <span>Systems</span>
            </button>

            {/* Tags Pill (Desktop only) */}
            <div className="tags-pill">
              <span>Real-Time AI</span>
              <span className="tag-dot-sep" />
              <span>Aviation Safety</span>
            </div>
          </div>

          {/* Right: Live Monitoring Pill */}
          <div className="nav-right">
            <Link to="/dashboard" className="status-pill" aria-label="Go to Live Monitoring Dashboard">
              <div className="status-icon-circle">
                <span className="status-green-dot" />
              </div>
              <span>Live Monitoring</span>
            </Link>
          </div>
        </motion.nav>

        {/* Systems Dropdown Panel */}
        <AnimatePresence>
          {systemsOpen && (
            <motion.div
              ref={panelRef}
              className="systems-panel"
              role="menu"
              aria-label="Systems Menu"
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.98 }}
              transition={{ duration: 0.22, ease: easeAerospace }}
            >
              {[
                { name: 'Live Dashboard', path: '/dashboard', desc: 'Real-time transcript stream', badge: '121.700' },
                { name: 'Terminal Radar', path: '/map', desc: 'Simulated scope & aircraft blips', badge: 'Scope' },
                { name: 'Verification Ledger', path: '/ledger', desc: 'Audit table & parameter diffs', badge: 'Strips' },
                { name: 'Safety Alerts', path: '/alerts', desc: 'Discrepancy feed & resolution', badge: 'Alerts' },
                { name: 'Safety Analytics', path: '/analytics', desc: 'KPIs, trendlines & error rates', badge: 'Reports' },
                { name: 'Pilot Training Mode', path: '/training', desc: 'Interactive read-back simulator', badge: 'Sim' },
                { name: 'System Settings', path: '/settings', desc: 'Engine & acoustic preferences', badge: 'Config' },
              ].map((item) => (
                <button
                  key={item.path}
                  role="menuitem"
                  className="systems-item-btn"
                  onClick={() => {
                    setSystemsOpen(false);
                    navigate(item.path);
                  }}
                >
                  <div className="systems-item-left">
                    <span className="systems-item-name">{item.name}</span>
                    <span className="systems-item-desc">{item.desc}</span>
                  </div>
                  <span className="systems-item-badge">{item.badge}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Layer 4: Bottom Pinned Content Over Smooth White Gradient Fade (z-index: 30) */}
        <motion.div
          className="hero-bottom-container"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5, duration: 1, ease: easeAerospace }}
        >
          <div className="hero-bottom-content">
            {/* Left Block */}
            <div className="hero-left-block">
              {/* Subtitle Line */}
              <motion.div
                className="hero-subtitle-line"
                initial={{ y: 16, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.6, duration: 0.8, ease: easeAerospace }}
              >
                <span className="hero-sub-dot" />
                <span>AI-Powered Radio Read-Back Safety Checker</span>
              </motion.div>

              {/* Large Responsive Headline: Balanced on 2 lines */}
              <motion.h1
                className="hero-heading"
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.8, duration: 0.8, ease: easeAerospace }}
              >
                Every Read-Back.
                <br />
                Verified.
              </motion.h1>

              {/* Subtitle Description */}
              <motion.p
                className="hero-description"
                initial={{ y: 16, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.9, duration: 0.8, ease: easeAerospace }}
              >
                Real-time AI monitoring of ATC-pilot radio exchanges. Detects miscommunications
                before they become incidents.
              </motion.p>

              {/* Two CTA Buttons */}
              <motion.div
                className="hero-actions"
                initial={{ y: 16, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 1.0, duration: 0.8, ease: easeAerospace }}
              >
                <Link to="/login" className="btn-primary-pill">
                  <span>Get Started</span>
                  <ArrowRight size={15} />
                </Link>
                <button
                  type="button"
                  onClick={scrollToFeatures}
                  className="btn-outline-pill"
                >
                  Watch Demo
                </button>
              </motion.div>
            </div>

            {/* Right Block: Three Stat / Tag Pills */}
            <motion.div
              className="hero-right-block"
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 1.1, duration: 0.8, ease: easeAerospace }}
            >
              <div className="stat-pill">
                <span className="stat-pill-indicator" />
                <span>&lt;2s Detection</span>
              </div>
              <div className="stat-pill">
                <span className="stat-pill-indicator" />
                <span>AI-Verified</span>
              </div>
              <div className="stat-pill">
                <span className="stat-pill-indicator" />
                <span>Always Listening</span>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </section>

      {/* ===================================================================
          SECTION 4: CORE CAPABILITIES (3 Enhanced Glass Cards)
          =================================================================== */}
      <section id="features" className="features-section">
        <div className="features-inner">
          <div className="features-header">
            <div className="section-tag">Aviation Safety Intelligence</div>
            <h2 className="section-title">
              Aerospace-grade precision at radio speed.
            </h2>
            <p className="section-subtitle">
              Engineered to detect miscommunications instantly during high-workload taxi,
              approach, and terminal phases.
            </p>
          </div>

          <div className="features-grid">
            {/* Card 1: Live Monitoring */}
            <div className="feature-glass-card">
              <div className="feature-icon-box">
                <Radio size={24} strokeWidth={1.8} />
              </div>
              <h3 className="feature-card-heading">Live Monitoring</h3>
              <p className="feature-card-body">
                Continuous acoustic stream ingestion and semantic parsing for ATC tower and approach frequencies.
                Captures callsigns, runway clearances, and altitude levels with millisecond timestamp synchronization.
              </p>
              <div className="feature-card-footer">
                <span>121.700 MHz Active</span>
                <span style={{ color: '#30D158', fontWeight: 600 }}>● Online</span>
              </div>
            </div>

            {/* Card 2: Instant Verification */}
            <div className="feature-glass-card">
              <div className="feature-icon-box">
                <ShieldCheck size={24} strokeWidth={1.8} />
              </div>
              <h3 className="feature-card-heading">Instant Verification</h3>
              <p className="feature-card-body">
                Deterministic comparison engine cross-checks pilot read-backs against controller issuances.
                Calculates altitude deltas, heading differences, and runway numbers with zero LLM hallucinations.
              </p>
              <div className="feature-card-footer">
                <span>Deterministic Logic</span>
                <span>100% Unit-Tested</span>
              </div>
            </div>

            {/* Card 3: Explainable Alerts */}
            <div className="feature-glass-card">
              <div className="feature-icon-box">
                <AlertTriangle size={24} strokeWidth={1.8} />
              </div>
              <h3 className="feature-card-heading">Explainable Alerts</h3>
              <p className="feature-card-body">
                Provides plain-English explanations of detected discrepancies. Distinguishes critical direction swaps
                (turn left vs turn right) from non-critical variance with clear severity categorization.
              </p>
              <div className="feature-card-footer">
                <span>High / Med / Low</span>
                <span>Immediate Audio Flag</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===================================================================
          SECTION A: HOW SAFECOMM WORKS (4-Step Horizontal Pipeline)
          =================================================================== */}
      <section id="how-it-works" className="how-it-works-section">
        <div className="features-inner">
          <div className="features-header">
            <div className="section-tag">Verification Pipeline</div>
            <h2 className="section-title">
              How SafeComm Works
            </h2>
            <p className="section-subtitle">
              From raw VHF radio transmission to deterministic safety verdict in less than two seconds.
            </p>
          </div>

          <div className="how-steps-grid">
            {/* Step 1 */}
            <div className="how-step-card">
              <span className="how-step-num">01 / CAPTURE</span>
              <div className="how-step-icon">
                <Radio size={20} strokeWidth={1.8} />
              </div>
              <h3 className="how-step-title">Radio Transmission</h3>
              <p className="how-step-body">
                Tower and approach VHF voice exchanges are continuously monitored or simulated with realistic
                ICAO standard aviation phraseology.
              </p>
            </div>

            {/* Step 2 */}
            <div className="how-step-card">
              <span className="how-step-num">02 / EXTRACT</span>
              <div className="how-step-icon">
                <Cpu size={20} strokeWidth={1.8} />
              </div>
              <h3 className="how-step-title">AI Instruction Extraction</h3>
              <p className="how-step-body">
                Large Language Models (Gemini or Grok) parse transcripts into a strict JSON schema containing
                callsign, instruction type, value, unit, and direction.
              </p>
            </div>

            {/* Step 3 */}
            <div className="how-step-card">
              <span className="how-step-num">03 / VERIFY</span>
              <div className="how-step-icon">
                <ShieldCheck size={20} strokeWidth={1.8} />
              </div>
              <h3 className="how-step-title">Deterministic Comparison</h3>
              <p className="how-step-body">
                Pure TypeScript rules engine compares controller issuance against pilot read-back.
                Math and logic decide verdicts, never an LLM guess.
              </p>
            </div>

            {/* Step 4 */}
            <div className="how-step-card">
              <span className="how-step-num">04 / RESOLVE</span>
              <div className="how-step-icon">
                <CheckCircle2 size={20} strokeWidth={1.8} />
              </div>
              <h3 className="how-step-title">Safety Verdict</h3>
              <p className="how-step-body">
                Immediate categorization into MATCH, MISMATCH, DIRECTION_ERROR, or OMISSION with plain-English
                explanations and audio alerts for high severity.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ===================================================================
          SECTION B: WHAT SAFECOMM VERIFIES (4 Core Discrepancy Modules)
          =================================================================== */}
      <section id="verifications" className="verifies-section">
        <div className="features-inner">
          <div className="features-header">
            <div className="section-tag">Safety Rules Engine</div>
            <h2 className="section-title">
              What SafeComm Verifies
            </h2>
            <p className="section-subtitle">
              High-risk flight clearances rigorously monitored for numeric deviations and dangerous direction inversions.
            </p>
          </div>

          <div className="verifies-grid">
            {/* Block 1: Heading */}
            <div className="verify-block">
              <div className="verify-header">
                <span className="verify-tag">HEADING · DIRECTION</span>
                <Compass size={20} color="#0A0A0A" />
              </div>
              <h3 className="verify-title">Heading &amp; Turn Direction</h3>
              <p className="verify-body">
                Detects critical left versus right turn swaps and magnetic course discrepancies before an aircraft
                turns into opposing airspace or conflicting traffic.
              </p>
              <div className="verify-example-chip">
                <span>ATC: Turn left 270°</span>
                <span style={{ color: '#FF3B30', fontWeight: 600 }}>Heard: Turn right 170° [HIGH]</span>
              </div>
            </div>

            {/* Block 2: Altitude */}
            <div className="verify-block">
              <div className="verify-header">
                <span className="verify-tag">ALTITUDE · LEVEL</span>
                <TrendingUp size={20} color="#0A0A0A" />
              </div>
              <h3 className="verify-title">Altitude &amp; Flight Levels</h3>
              <p className="verify-body">
                Cross-references assigned flight levels, step-down descents, and climb clearances. Prevents thousand-foot
                level busts and altitude confusion.
              </p>
              <div className="verify-example-chip">
                <span>ATC: Descend FL100</span>
                <span style={{ color: '#FF9F0A', fontWeight: 600 }}>Heard: Descend FL110 [MED]</span>
              </div>
            </div>

            {/* Block 3: Runway */}
            <div className="verify-block">
              <div className="verify-header">
                <span className="verify-tag">RUNWAY · TAXI</span>
                <MapPin size={20} color="#0A0A0A" />
              </div>
              <h3 className="verify-title">Runway Alignment &amp; Clearances</h3>
              <p className="verify-body">
                Verifies takeoff, landing, and crossing clearances on complex parallel runway layouts (such as 27L vs 27R)
                to prevent runway incursion hazards.
              </p>
              <div className="verify-example-chip">
                <span>ATC: Cleared 27L</span>
                <span style={{ color: '#30D158', fontWeight: 600 }}>Heard: Cleared 27L [MATCH]</span>
              </div>
            </div>

            {/* Block 4: Clearances */}
            <div className="verify-block">
              <div className="verify-header">
                <span className="verify-tag">HOLD SHORT · MANDATORY</span>
                <Layers size={20} color="#0A0A0A" />
              </div>
              <h3 className="verify-title">Mandatory Instruction Holds</h3>
              <p className="verify-body">
                Flags omissions where mandatory read-back instructions (such as "Hold Short Runway 09" or altimeter settings)
                are missed or partially omitted by flight crew.
              </p>
              <div className="verify-example-chip">
                <span>ATC: Hold short RWY 09</span>
                <span style={{ color: '#FF9F0A', fontWeight: 600 }}>Heard: (Omitted) [PARTIAL]</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===================================================================
          SECTION C: THE SAFECOMM CONSOLE (Interactive Module Preview)
          =================================================================== */}
      <section id="console" className="console-section">
        <div className="features-inner">
          <div className="features-header">
            <div className="section-tag">Product Preview</div>
            <h2 className="section-title">
              The SafeComm Console
            </h2>
            <p className="section-subtitle">
              A unified operational environment designed for air traffic controllers, safety officers, and flight analysts.
            </p>
          </div>

          {/* Console Module Selector Tabs */}
          <div className="console-tabs" role="tablist">
            {CONSOLE_TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`console-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Console Preview Card */}
          <div className="console-preview-card">
            <div className="console-preview-bar">
              <div className="console-dot-group">
                <div className="console-dot" />
                <div className="console-dot" />
                <div className="console-dot" />
              </div>
              <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: '#71717A' }}>
                SafeComm Console · {currentConsoleTab.badge} · PROTOTYPE ARCHITECTURE PREVIEW
              </span>
              <Link
                to={currentConsoleTab.route}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: '#0A0A0A',
                }}
              >
                <span>Launch View</span>
                <ExternalLink size={13} />
              </Link>
            </div>

            <div className="console-preview-body">
              <div style={{ maxWidth: '780px', marginBottom: '28px' }}>
                <span
                  style={{
                    display: 'inline-block',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    color: '#71717A',
                    marginBottom: '8px',
                  }}
                >
                  MODULE ARCHITECTURE
                </span>
                <h3 style={{ fontSize: '24px', fontWeight: 600, letterSpacing: '-0.025em', color: '#0A0A0A', marginBottom: '12px' }}>
                  {currentConsoleTab.title}
                </h3>
                <p style={{ fontSize: '15px', lineHeight: 1.6, color: '#52525B' }}>
                  {currentConsoleTab.desc}
                </p>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                  gap: '16px',
                  paddingTop: '20px',
                  borderTop: '1px solid rgba(0, 0, 0, 0.08)',
                }}
              >
                {currentConsoleTab.features.map((feat, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                      fontSize: '13.5px',
                      color: '#0A0A0A',
                    }}
                  >
                    <CheckCircle2 size={16} color="#30D158" style={{ marginTop: '2px', flexShrink: 0 }} />
                    <span>{feat}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===================================================================
          SECTION D: FINAL CALL TO ACTION
          =================================================================== */}
      <section id="cta" className="final-cta-section">
        <div className="final-cta-box">
          <div className="section-tag">Zero Ambiguity in the Cockpit</div>
          <h2 className="final-cta-title">
            Bring clarity to every read-back.
          </h2>
          <p className="final-cta-desc">
            Simulated real-time AI monitoring for air traffic control radio exchanges.
            Built for controllers, pilots, and safety investigators.
          </p>
          <div className="final-cta-buttons">
            <Link to="/login" className="btn-primary-pill">
              <span>Get Started</span>
              <ArrowRight size={15} />
            </Link>
            <Link to="/dashboard" className="btn-outline-pill">
              Launch Simulation
            </Link>
          </div>
        </div>
      </section>

      {/* ===================================================================
          SECTION E: FOOTER
          =================================================================== */}
      <footer className="landing-footer">
        <div className="footer-top">
          {/* Brand Column */}
          <div className="footer-brand-col">
            <Link to="/" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <svg width="24" height="24" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14.5 7C10.5 7 7.5 10.2 7.5 14.5C7.5 18.8 10.2 21.2 13.8 23.2C17.5 25.2 20.2 27 20.2 30.5C20.2 33.8 17.5 36 13.8 36C10.2 36 7.8 33.5 7.5 30.2L4 30.5C4.5 35.8 8.5 39.5 13.8 39.5C19.5 39.5 23.8 35.5 23.8 30.2C23.8 25.5 20.5 22.8 16.5 20.5C13 18.5 11 16.8 11 14.2C11 11.5 13 9.8 15.5 9.8C18.2 9.8 20.2 11.8 20.8 14.8L24.2 14.2C23.2 9.8 19.5 7 14.5 7Z" fill="#0A0A0A"/>
                <path d="M27.2 4.5L28.8 4.5L29.3 8.2L34.5 11.2V12.8L29.3 11.2L29.1 15.5L31.2 17.2V18.2L28 17.5L24.8 18.2V17.2L26.9 15.5L26.7 11.2L21.5 12.8V11.2L26.7 8.2L27.2 4.5Z" fill="#0A0A0A"/>
                <rect x="23" y="24" width="2" height="12" rx="1" fill="#0A0A0A"/>
                <rect x="26.5" y="21" width="2" height="15" rx="1" fill="#0A0A0A"/>
                <rect x="30" y="19" width="2" height="17" rx="1" fill="#0A0A0A"/>
                <rect x="33.5" y="22" width="2" height="14" rx="1" fill="#0A0A0A"/>
                <rect x="37" y="26" width="2" height="10" rx="1" fill="#0A0A0A"/>
              </svg>
              <span style={{ fontSize: '18px', fontWeight: 600, letterSpacing: '-0.02em', color: '#0A0A0A' }}>
                SafeComm
              </span>
            </Link>
            <p className="footer-brand-desc">
              AI-powered real-time monitoring and deterministic verification for air traffic control radio exchanges.
            </p>
          </div>

          {/* Links Grid */}
          <div className="footer-links-grid">
            <div>
              <h4 className="footer-col-title">Platform</h4>
              <ul className="footer-col-links">
                <li className="footer-link-item"><Link to="/dashboard">Live Dashboard</Link></li>
                <li className="footer-link-item"><Link to="/map">Terminal Radar</Link></li>
                <li className="footer-link-item"><Link to="/ledger">Flight Strips</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="footer-col-title">Intelligence</h4>
              <ul className="footer-col-links">
                <li className="footer-link-item"><Link to="/alerts">Safety Alerts</Link></li>
                <li className="footer-link-item"><Link to="/analytics">Analytics &amp; KPIs</Link></li>
                <li className="footer-link-item"><Link to="/training">Pilot Training</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="footer-col-title">System</h4>
              <ul className="footer-col-links">
                <li className="footer-link-item"><Link to="/settings">Settings</Link></li>
                <li className="footer-link-item"><Link to="/login">Sign In</Link></li>
                <li className="footer-link-item"><a href="#features">Documentation</a></li>
              </ul>
            </div>
          </div>
        </div>

        {/* Footer Bottom */}
        <div className="footer-bottom">
          <p className="footer-copy">
            SafeComm AI Aerospace Systems &copy; {new Date().getFullYear()} — Every Read-Back. Verified.
          </p>
          <div className="footer-badge">
            Prototype — Research/portfolio build. Not certified for operational aviation use.
          </div>
        </div>
      </footer>
    </div>
  );
};
