import React, { useState } from 'react';
import {
  GraduationCap,
  Flame,
  Trophy,
  Target,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  RotateCcw,
  Send,
  Radio,
  Volume2,
  ChevronRight,
  Sparkles,
  Info,
} from 'lucide-react';
import {
  TRAINING_SCENARIOS,
  type TrainingScenarioItem,
  gradeTrainingReadback,
  type TrainingGradeResult,
} from '../lib/trainingEngine';
import './Training.css';

const LOCAL_STORAGE_STREAK_KEY = 'safecomm_training_streak';
const LOCAL_STORAGE_BEST_STREAK_KEY = 'safecomm_training_best_streak';
const LOCAL_STORAGE_TOTAL_KEY = 'safecomm_training_total';
const LOCAL_STORAGE_CORRECT_KEY = 'safecomm_training_correct';

export const Training: React.FC = () => {
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [readbackInput, setReadbackInput] = useState<string>('');
  const [gradeResult, setGradeResult] = useState<TrainingGradeResult | null>(null);
  const [isGrading, setIsGrading] = useState<boolean>(false);
  const [showHint, setShowHint] = useState<boolean>(false);

  // Scoreboard state in localStorage
  const [streak, setStreak] = useState<number>(() => {
    return parseInt(localStorage.getItem(LOCAL_STORAGE_STREAK_KEY) || '0', 10);
  });
  const [bestStreak, setBestStreak] = useState<number>(() => {
    return parseInt(localStorage.getItem(LOCAL_STORAGE_BEST_STREAK_KEY) || '0', 10);
  });
  const [totalAttempts, setTotalAttempts] = useState<number>(() => {
    return parseInt(localStorage.getItem(LOCAL_STORAGE_TOTAL_KEY) || '0', 10);
  });
  const [correctAttempts, setCorrectAttempts] = useState<number>(() => {
    return parseInt(localStorage.getItem(LOCAL_STORAGE_CORRECT_KEY) || '0', 10);
  });

  const currentScenario: TrainingScenarioItem = TRAINING_SCENARIOS[currentIndex];

  // Grade user readback
  const handleGrade = () => {
    if (!readbackInput.trim() || isGrading) return;
    setIsGrading(true);

    const result = gradeTrainingReadback(currentScenario.clearanceText, readbackInput);
    setGradeResult(result);

    const newTotal = totalAttempts + 1;
    setTotalAttempts(newTotal);
    localStorage.setItem(LOCAL_STORAGE_TOTAL_KEY, String(newTotal));

    if (result.isMatch) {
      const newStreak = streak + 1;
      setStreak(newStreak);
      localStorage.setItem(LOCAL_STORAGE_STREAK_KEY, String(newStreak));

      if (newStreak > bestStreak) {
        setBestStreak(newStreak);
        localStorage.setItem(LOCAL_STORAGE_BEST_STREAK_KEY, String(newStreak));
      }

      const newCorrect = correctAttempts + 1;
      setCorrectAttempts(newCorrect);
      localStorage.setItem(LOCAL_STORAGE_CORRECT_KEY, String(newCorrect));
    } else {
      // Streak breaks on mismatch or partial readback
      setStreak(0);
      localStorage.setItem(LOCAL_STORAGE_STREAK_KEY, '0');
    }

    setIsGrading(false);
  };

  // Next clearance
  const handleNext = () => {
    const nextIdx = (currentIndex + 1) % TRAINING_SCENARIOS.length;
    setCurrentIndex(nextIdx);
    setReadbackInput('');
    setGradeResult(null);
    setShowHint(false);
  };

  // Select scenario
  const handleSelectScenario = (index: number) => {
    setCurrentIndex(index);
    setReadbackInput('');
    setGradeResult(null);
    setShowHint(false);
  };

  // Reset scorecard
  const handleResetScore = () => {
    if (window.confirm('Reset your training score and streak counters?')) {
      setStreak(0);
      setBestStreak(0);
      setTotalAttempts(0);
      setCorrectAttempts(0);
      localStorage.removeItem(LOCAL_STORAGE_STREAK_KEY);
      localStorage.removeItem(LOCAL_STORAGE_BEST_STREAK_KEY);
      localStorage.removeItem(LOCAL_STORAGE_TOTAL_KEY);
      localStorage.removeItem(LOCAL_STORAGE_CORRECT_KEY);
    }
  };

  // Inject readback shortcut
  const handleInject = (text: string) => {
    setReadbackInput(text);
    setGradeResult(null);
  };

  const accuracyPct =
    totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;

  return (
    <div className="training-page-container">
      {/* Header */}
      <header className="training-header">
        <div className="training-header-left">
          <h1>
            <GraduationCap size={28} color="#3b82f6" />
            Pilot Mode · Read-Back Training Simulator
          </h1>
          <p>
            Listen to controller clearances, formulate the pilot read-back, and get graded instantly by SafeComm’s deterministic safety engine.
          </p>
        </div>
        <div>
          <button
            type="button"
            className="retry-btn"
            onClick={handleResetScore}
            title="Reset training streak and stats"
          >
            <RotateCcw size={14} />
            <span>Reset Stats</span>
          </button>
        </div>
      </header>

      {/* Scoreboard Bar */}
      <div className="training-score-bar">
        <div className="training-score-card">
          <div className="training-score-icon streak">
            <Flame size={22} />
          </div>
          <div>
            <div className="training-score-label">Current Streak</div>
            <div className="training-score-val" style={{ color: '#f59e0b' }}>
              {streak} 🔥
            </div>
          </div>
        </div>

        <div className="training-score-card">
          <div className="training-score-icon trophy">
            <Trophy size={22} />
          </div>
          <div>
            <div className="training-score-label">Best Streak</div>
            <div className="training-score-val" style={{ color: '#60a5fa' }}>
              {bestStreak}
            </div>
          </div>
        </div>

        <div className="training-score-card">
          <div className="training-score-icon accuracy">
            <Target size={22} />
          </div>
          <div>
            <div className="training-score-label">Verification Rate</div>
            <div className="training-score-val" style={{ color: '#10b981' }}>
              {accuracyPct}%
            </div>
          </div>
        </div>

        <div className="training-score-card">
          <div className="training-score-icon total">
            <CheckCircle2 size={22} />
          </div>
          <div>
            <div className="training-score-label">Total Completed</div>
            <div className="training-score-val">
              {correctAttempts}/{totalAttempts}
            </div>
          </div>
        </div>
      </div>

      {/* Main Interactive Challenge Card */}
      <div className="training-challenge-card">
        {/* Top Meta */}
        <div className="challenge-top-meta">
          <div className="challenge-meta-left">
            <span className="challenge-index-badge">
              Clearance {currentIndex + 1} of {TRAINING_SCENARIOS.length}
            </span>
            <span className={`challenge-diff-badge ${currentScenario.difficulty}`}>
              {currentScenario.difficulty}
            </span>
          </div>

          <div className="challenge-station-text">
            <Radio size={14} />
            <span>{currentScenario.station}</span>
          </div>
        </div>

        {/* Controller Clearance Audio Box */}
        <div className="controller-clearance-box">
          <div className="clearance-speaker-tag">
            <Volume2 size={16} />
            <span>Air Traffic Controller Clearance</span>
            <div className="clearance-audio-wave">
              <span />
              <span />
              <span />
            </div>
          </div>
          <p className="clearance-statement">“{currentScenario.clearanceText}”</p>
        </div>

        {/* Pilot Input Box */}
        <div className="pilot-input-area">
          <label htmlFor="pilot-readback-input" className="pilot-input-label">
            <span>Your Spoken Read-Back:</span>
            <button
              type="button"
              className="inject-chip-btn"
              onClick={() => setShowHint(!showHint)}
              style={{ fontSize: 11 }}
            >
              <Info size={12} style={{ display: 'inline', marginRight: 4 }} />
              {showHint ? 'Hide Clearance Note' : 'Show Clearance Note'}
            </button>
          </label>

          {showHint && (
            <div
              style={{
                fontSize: 13,
                color: '#60a5fa',
                background: 'rgba(59, 130, 246, 0.08)',
                padding: '8px 12px',
                borderRadius: 6,
                border: '1px solid rgba(59, 130, 246, 0.2)',
              }}
            >
              <strong>Safety Parameter Focus:</strong> {currentScenario.safetyTrapNote}
            </div>
          )}

          <textarea
            id="pilot-readback-input"
            className="pilot-readback-textarea"
            placeholder="Type your pilot read-back exactly as spoken (e.g. Turn right heading 090, maintain 3000 until established, United 421)…"
            value={readbackInput}
            onChange={(e) => setReadbackInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleGrade();
              }
            }}
          />

          {/* Action Row */}
          <div className="training-action-row">
            <div className="inject-options-wrapper">
              <span className="inject-title">Quick Simulation:</span>
              <button
                type="button"
                className="inject-chip-btn nominal"
                onClick={() => handleInject(currentScenario.referenceReadback)}
                title="Populate ideal nominal read-back"
              >
                <Sparkles size={11} style={{ display: 'inline', marginRight: 4 }} />
                Nominal Match
              </button>

              {currentScenario.exampleErrors.map((err, i) => (
                <button
                  key={i}
                  type="button"
                  className="inject-chip-btn error"
                  onClick={() => handleInject(err.text)}
                  title={err.label}
                >
                  <AlertTriangle size={11} style={{ display: 'inline', marginRight: 4 }} />
                  {err.label.split('(')[0].trim()}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="submit-readback-btn"
              onClick={handleGrade}
              disabled={!readbackInput.trim() || isGrading}
              aria-label="Grade pilot read-back"
            >
              <Send size={15} />
              <span>{isGrading ? 'Grading…' : 'Submit Read-Back'}</span>
            </button>
          </div>
        </div>

        {/* Verdict Feedback Screen Style Display */}
        {gradeResult && (
          <div
            className={`verdict-feedback-panel ${
              gradeResult.verdict.outcome === 'MATCH'
                ? 'match'
                : gradeResult.verdict.outcome === 'MISMATCH'
                ? 'mismatch'
                : 'partial'
            }`}
          >
            {/* Verdict Header */}
            <div className="verdict-banner-header">
              <div className="verdict-banner-title">
                {gradeResult.verdict.outcome === 'MATCH' ? (
                  <>
                    <CheckCircle2 size={24} />
                    <span>VERDICT: MATCH — Read-Back Verified (100% Parameter Match)</span>
                  </>
                ) : gradeResult.verdict.outcome === 'MISMATCH' ? (
                  <>
                    <AlertTriangle size={24} />
                    <span>VERDICT: CRITICAL MISMATCH — Safety Deviation Detected</span>
                  </>
                ) : (
                  <>
                    <AlertCircle size={24} />
                    <span>VERDICT: PARTIAL — Omitted Required Clearance Parameters</span>
                  </>
                )}
              </div>

              <div className="verdict-nav-row">
                {gradeResult.isMatch ? (
                  <button type="button" className="next-clearance-btn" onClick={handleNext}>
                    <span>Next Clearance</span>
                    <ChevronRight size={14} />
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="retry-btn"
                      onClick={() => {
                        setGradeResult(null);
                      }}
                    >
                      <RotateCcw size={13} />
                      <span>Try Again</span>
                    </button>
                    <button type="button" className="next-clearance-btn" onClick={handleNext}>
                      <span>Skip to Next</span>
                      <ChevronRight size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Explanation Message */}
            <div className="verdict-msg-box">
              {gradeResult.formattedMessage}
            </div>

            {/* Parameter Chips Grid */}
            <div className="verdict-chips-grid">
              {/* Matched Fields */}
              {gradeResult.verdict.matchedFields.map((f, i) => (
                <span key={`m-${i}`} className="verdict-chip matched">
                  <CheckCircle2 size={12} />
                  {f}
                </span>
              ))}

              {/* Mismatched Fields */}
              {gradeResult.verdict.mismatchedFields.map((f, i) => (
                <span key={`mm-${i}`} className="verdict-chip mismatched">
                  <AlertTriangle size={12} />
                  {f}
                </span>
              ))}

              {/* Omitted Fields */}
              {(gradeResult.verdict.omittedFields || []).map((f, i) => (
                <span key={`om-${i}`} className="verdict-chip omitted">
                  <AlertCircle size={12} />
                  {f}
                </span>
              ))}
            </div>

            {/* Model Read-Back Reference if not match */}
            {!gradeResult.isMatch && (
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--text-secondary)',
                  paddingTop: 8,
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <strong style={{ color: '#10b981' }}>Standard Nominal Read-Back:</strong> “{currentScenario.referenceReadback}”
              </div>
            )}
          </div>
        )}
      </div>

      {/* Scenario Index Selector Strip */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
          Jump to Clearance Scenario:
        </div>
        <div className="scenario-nav-strip">
          {TRAINING_SCENARIOS.map((scenario, index) => (
            <button
              key={scenario.id}
              type="button"
              className={`scenario-pill-btn ${index === currentIndex ? 'is-active' : ''}`}
              onClick={() => handleSelectScenario(index)}
            >
              #{index + 1} {scenario.callsign} ({scenario.difficulty})
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
