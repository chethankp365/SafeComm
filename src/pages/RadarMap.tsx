import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Radar,
  RefreshCw,
  Layers,
  Plane,
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  AlertOctagon,
  HelpCircle,
} from 'lucide-react';
import {
  fetchRadarScopeAircraft,
  calculateDeterministicRadarPosition,
  type RadarAircraft,
} from '../lib/ledgerService';
import './RadarMap.css';

// Radar Theme Palettes
type RadarTheme = 'green' | 'cyan' | 'amber';

interface PaletteColors {
  background: string;
  gridLine: string;
  gridText: string;
  runway: string;
  runwayMarking: string;
  sweepLine: string;
  sweepGlow: string;
  targetBlip: string;
  targetSelected: string;
  dataBlockText: string;
  dataBlockBg: string;
  waypoint: string;
}

const PALETTES: Record<RadarTheme, PaletteColors> = {
  green: {
    background: '#020707',
    gridLine: 'rgba(0, 255, 136, 0.16)',
    gridText: 'rgba(0, 255, 136, 0.65)',
    runway: '#18382b',
    runwayMarking: '#00ff88',
    sweepLine: '#00ff88',
    sweepGlow: 'rgba(0, 255, 136, 0.15)',
    targetBlip: '#00ffaa',
    targetSelected: '#ffffff',
    dataBlockText: '#c4f7db',
    dataBlockBg: 'rgba(2, 20, 14, 0.85)',
    waypoint: 'rgba(0, 255, 136, 0.35)',
  },
  cyan: {
    background: '#030a12',
    gridLine: 'rgba(0, 217, 255, 0.16)',
    gridText: 'rgba(0, 217, 255, 0.70)',
    runway: '#132838',
    runwayMarking: '#00e5ff',
    sweepLine: '#00e5ff',
    sweepGlow: 'rgba(0, 229, 255, 0.15)',
    targetBlip: '#38bdf8',
    targetSelected: '#ffffff',
    dataBlockText: '#bae6fd',
    dataBlockBg: 'rgba(3, 18, 30, 0.85)',
    waypoint: 'rgba(0, 217, 255, 0.35)',
  },
  amber: {
    background: '#0d0701',
    gridLine: 'rgba(255, 170, 0, 0.18)',
    gridText: 'rgba(255, 170, 0, 0.70)',
    runway: '#3b2308',
    runwayMarking: '#ffaa00',
    sweepLine: '#ffaa00',
    sweepGlow: 'rgba(255, 170, 0, 0.15)',
    targetBlip: '#fbbf24',
    targetSelected: '#ffffff',
    dataBlockText: '#fde68a',
    dataBlockBg: 'rgba(28, 14, 2, 0.85)',
    waypoint: 'rgba(255, 170, 0, 0.35)',
  },
};

// Navigational fixes around simulated terminal airspace
const WAYPOINTS = [
  { name: 'ARCHI', angle: 45, radius: 0.75 },
  { name: 'EDDYY', angle: 125, radius: 0.65 },
  { name: 'CEPIN', angle: 215, radius: 0.70 },
  { name: 'DUMBA', angle: 300, radius: 0.80 },
  { name: 'BRIXX', angle: 165, radius: 0.40 },
  { name: 'MENLO', angle: 260, radius: 0.50 },
];

export const RadarMap: React.FC = () => {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [aircraftList, setAircraftList] = useState<RadarAircraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCallsign, setSelectedCallsign] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('ALL');
  const [radarTheme, setRadarTheme] = useState<RadarTheme>('green');

  // Layer toggles
  const [showTargets, setShowTargets] = useState(true);
  const [showRangeRings, setShowRangeRings] = useState(true);
  const [showRunways, setShowRunways] = useState(true);
  const [showSweep, setShowSweep] = useState(true);
  const [showWaypoints, setShowWaypoints] = useState(true);

  // Load real Supabase aircraft tracks
  const loadAircraft = useCallback(async () => {
    setLoading(true);
    const res = await fetchRadarScopeAircraft();
    if (res.aircraft) {
      setAircraftList(res.aircraft);
      // Auto-select first aircraft if none selected
      if (!selectedCallsign && res.aircraft.length > 0) {
        setSelectedCallsign(res.aircraft[0].callsign);
      }
    }
    setLoading(false);
  }, [selectedCallsign]);

  useEffect(() => {
    loadAircraft();
  }, [loadAircraft]);

  // Distinct sessions list
  const sessions = useMemo(() => {
    const map = new Map<string, string>();
    aircraftList.forEach((a) => {
      if (a.session_id && !map.has(a.session_id)) {
        map.set(a.session_id, a.scenario_name);
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [aircraftList]);

  // Filtered aircraft by selected session
  const filteredAircraft = useMemo(() => {
    if (selectedSessionId === 'ALL') return aircraftList;
    return aircraftList.filter((a) => a.session_id === selectedSessionId);
  }, [aircraftList, selectedSessionId]);

  // Selected aircraft details
  const activeAircraft = useMemo(() => {
    return filteredAircraft.find((a) => a.callsign === selectedCallsign) || filteredAircraft[0] || null;
  }, [filteredAircraft, selectedCallsign]);

  // Sweep rotation state (radians)
  const sweepAngleRef = useRef(0);
  const targetCoordinatesRef = useRef<Map<string, { x: number; y: number; r: number }>>(new Map());

  // Main Canvas Radar Scope Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let lastTime = performance.now();

    const render = (time: number) => {
      const dt = (time - lastTime) / 1000;
      lastTime = time;

      // Update sweep angle (1 full revolution every ~3.5 seconds)
      sweepAngleRef.current = (sweepAngleRef.current + dt * (Math.PI * 2) / 3.5) % (Math.PI * 2);

      // Handle HiDPI resolution
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = rect.width;
      const height = rect.height;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      const cx = width / 2;
      const cy = height / 2;
      const maxRadius = Math.min(width, height) * 0.44;

      const palette = PALETTES[radarTheme];

      // 1. Clear background
      ctx.fillStyle = palette.background;
      ctx.fillRect(0, 0, width, height);

      // 2. Radar Range Rings & Azimuth Grid
      if (showRangeRings) {
        ctx.strokeStyle = palette.gridLine;
        ctx.lineWidth = 1;

        // Concentric rings (5, 10, 15, 20, 25 NM)
        const rings = [0.2, 0.4, 0.6, 0.8, 1.0];
        const ringDistances = ['5 NM', '10 NM', '15 NM', '20 NM', '25 NM'];

        rings.forEach((factor, idx) => {
          const r = maxRadius * factor;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();

          // Distance labels
          ctx.fillStyle = palette.gridText;
          ctx.font = '10px ui-monospace, Consolas, monospace';
          ctx.textAlign = 'left';
          ctx.fillText(ringDistances[idx], cx + 4, cy - r + 12);
        });

        // 30-degree azimuth radial lines
        for (let a = 0; a < 360; a += 30) {
          const rad = (a * Math.PI) / 180;
          const x1 = cx + maxRadius * 0.15 * Math.sin(rad);
          const y1 = cy - maxRadius * 0.15 * Math.cos(rad);
          const x2 = cx + maxRadius * Math.sin(rad);
          const y2 = cy - maxRadius * Math.cos(rad);

          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();

          // Degree marker
          const degX = cx + (maxRadius + 14) * Math.sin(rad);
          const degY = cy - (maxRadius + 14) * Math.cos(rad);
          ctx.fillStyle = palette.gridText;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = '9px ui-monospace, Consolas, monospace';
          ctx.fillText(`${String(a).padStart(3, '0')}°`, degX, degY);
        }

        // Center crosshair
        ctx.strokeStyle = palette.gridText;
        ctx.beginPath();
        ctx.moveTo(cx - 8, cy);
        ctx.lineTo(cx + 8, cy);
        ctx.moveTo(cx, cy - 8);
        ctx.lineTo(cx, cy + 8);
        ctx.stroke();
      }

      // 3. Runway Centerlines & Terminal Layout
      if (showRunways) {
        ctx.save();
        ctx.translate(cx, cy);

        // Runway 28L / 28R (heading ~284°, drawn at standard angle)
        const rwAngle = (-76 * Math.PI) / 180;
        ctx.rotate(rwAngle);

        // Runway 28L
        ctx.fillStyle = palette.runway;
        ctx.fillRect(-6, -30, 4, 60);
        ctx.strokeStyle = palette.runwayMarking;
        ctx.lineWidth = 1;
        ctx.strokeRect(-6, -30, 4, 60);

        // Runway 28R
        ctx.fillStyle = palette.runway;
        ctx.fillRect(4, -34, 4, 68);
        ctx.strokeRect(4, -34, 4, 68);

        // Extended Localizer Approach Feathers
        ctx.strokeStyle = palette.gridText;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(-4, -30);
        ctx.lineTo(-4, -maxRadius * 0.85);
        ctx.moveTo(6, -34);
        ctx.lineTo(6, -maxRadius * 0.85);
        ctx.stroke();
        ctx.setLineDash([]);

        // Runway Labels
        ctx.fillStyle = palette.runwayMarking;
        ctx.font = 'bold 9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('28L', -4, -36);
        ctx.fillText('28R', 6, -40);

        ctx.restore();
      }

      // 4. Navigation Waypoints
      if (showWaypoints) {
        WAYPOINTS.forEach((wp) => {
          const rad = (wp.angle * Math.PI) / 180;
          const wx = cx + maxRadius * wp.radius * Math.sin(rad);
          const wy = cy - maxRadius * wp.radius * Math.cos(rad);

          // Waypoint triangle symbol
          ctx.strokeStyle = palette.waypoint;
          ctx.fillStyle = palette.waypoint;
          ctx.beginPath();
          ctx.moveTo(wx, wy - 4);
          ctx.lineTo(wx + 4, wy + 4);
          ctx.lineTo(wx - 4, wy + 4);
          ctx.closePath();
          ctx.stroke();

          // Fix label
          ctx.font = '9px ui-monospace, Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(wp.name, wx, wy + 13);
        });
      }

      // 5. Sweeping Radar Line with Afterglow
      if (showSweep) {
        const sweepAngle = sweepAngleRef.current;
        const sweepX = cx + maxRadius * Math.sin(sweepAngle);
        const sweepY = cy - maxRadius * Math.cos(sweepAngle);

        // Phosphor Afterglow Wedge trailing the sweep
        const glowSteps = 24;
        const glowSpan = (40 * Math.PI) / 180;
        for (let i = 0; i < glowSteps; i++) {
          const alpha = (1 - i / glowSteps) * 0.12;
          const a1 = sweepAngle - (i / glowSteps) * glowSpan;
          const a2 = sweepAngle - ((i + 1) / glowSteps) * glowSpan;

          ctx.fillStyle = palette.sweepGlow.replace(/[\d.]+\)$/, `${alpha})`);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, maxRadius, a2 - Math.PI / 2, a1 - Math.PI / 2);
          ctx.closePath();
          ctx.fill();
        }

        // Active Sweep Beam
        ctx.strokeStyle = palette.sweepLine;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sweepX, sweepY);
        ctx.stroke();
      }

      // 6. Aircraft Blips and Flight Data Blocks
      if (showTargets && filteredAircraft.length > 0) {
        targetCoordinatesRef.current.clear();

        filteredAircraft.forEach((ac) => {
          const pos = calculateDeterministicRadarPosition(
            ac.callsign,
            ac.session_id,
            ac.assigned_heading
          );
          const rad = (pos.angleDeg * Math.PI) / 180;
          const bx = cx + maxRadius * pos.radiusFactor * Math.sin(rad);
          const by = cy - maxRadius * pos.radiusFactor * Math.cos(rad);

          // Save hit detection coordinates
          targetCoordinatesRef.current.set(ac.callsign, { x: bx, y: by, r: 16 });

          const isSelected = ac.callsign === selectedCallsign;

          // Target Symbol (Diamond/Square)
          ctx.save();
          ctx.translate(bx, by);

          // Selection highlight halo
          if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(0, 0, 10, 0, Math.PI * 2);
            ctx.stroke();

            // Corner reticles
            ctx.strokeStyle = palette.targetBlip;
            ctx.lineWidth = 1;
            ctx.strokeRect(-12, -12, 24, 24);
          }

          // Blip Center Square
          const isMismatch = ac.latest_outcome === 'MISMATCH';
          ctx.fillStyle = isMismatch ? '#ff3b30' : isSelected ? '#ffffff' : palette.targetBlip;
          ctx.beginPath();
          ctx.rect(-3.5, -3.5, 7, 7);
          ctx.fill();

          // Velocity Vector Arrow (Heading direction line)
          const hRad = ((pos.headingDeg - 90) * Math.PI) / 180;
          const vectorLen = 22;
          ctx.strokeStyle = isMismatch ? '#ff3b30' : palette.targetBlip;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(vectorLen * Math.cos(hRad), vectorLen * Math.sin(hRad));
          ctx.stroke();

          ctx.restore();

          // Flight Data Block (FDB)
          const fdbOffsetX = 18;
          const fdbOffsetY = -18;
          const fdbX = bx + fdbOffsetX;
          const fdbY = by + fdbOffsetY;

          // Leader line connecting target to data block
          ctx.strokeStyle = palette.gridText;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(bx + 4, by - 4);
          ctx.lineTo(fdbX, fdbY + 12);
          ctx.stroke();

          // FDB Background Pill
          const fdbWidth = 72;
          const fdbHeight = 36;
          ctx.fillStyle = palette.dataBlockBg;
          ctx.strokeStyle = isSelected ? '#ffffff' : isMismatch ? '#ff3b30' : palette.gridLine;
          ctx.lineWidth = isSelected ? 1.5 : 1;
          ctx.fillRect(fdbX, fdbY, fdbWidth, fdbHeight);
          ctx.strokeRect(fdbX, fdbY, fdbWidth, fdbHeight);

          // FDB Lines:
          // Line 1: Callsign
          ctx.font = 'bold 10px ui-monospace, Consolas, monospace';
          ctx.fillStyle = isSelected ? '#ffffff' : isMismatch ? '#ff4d4f' : palette.dataBlockText;
          ctx.textAlign = 'left';
          ctx.fillText(ac.callsign, fdbX + 4, fdbY + 11);

          // Line 2: Altitude + Climb/Descend + Ground Speed (e.g. 030↑ 210)
          const altHundreds = Math.round(Number(ac.assigned_altitude || 3000) / 100);
          const altFormatted = `${String(altHundreds).padStart(3, '0')}↑ 210`;
          ctx.font = '9px ui-monospace, Consolas, monospace';
          ctx.fillStyle = palette.dataBlockText;
          ctx.fillText(altFormatted, fdbX + 4, fdbY + 22);

          // Line 3: Heading + Squawk (e.g. H090 4215)
          const hdgText = `H${String(ac.assigned_heading || '090').padStart(3, '0')} ${ac.assigned_squawk || '4215'}`;
          ctx.fillText(hdgText, fdbX + 4, fdbY + 32);
        });
      }

      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrameId);
  }, [radarTheme, showTargets, showRangeRings, showRunways, showSweep, showWaypoints, filteredAircraft, selectedCallsign]);

  // Click on radar canvas to select blip
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    for (const [callsign, coords] of targetCoordinatesRef.current.entries()) {
      const dist = Math.hypot(clickX - coords.x, clickY - coords.y);
      if (dist <= 26) {
        setSelectedCallsign(callsign);
        return;
      }
    }
  };

  return (
    <div className="radar-page-container">
      {/* Top Header */}
      <div className="radar-page-header">
        <div className="radar-title-group">
          <h1>
            <Radar size={26} strokeWidth={2.2} />
            Terminal Radar Scope
            <span className="radar-scope-badge">TRACON PRIMARY RADAR</span>
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
            Real-time aerospace terminal display plotting active aircraft targets and safety verification telemetry from Supabase.
          </p>
        </div>

        <div className="radar-header-controls">
          <button
            type="button"
            className="radar-btn"
            onClick={loadAircraft}
            disabled={loading}
            title="Refresh radar targets from Supabase"
            id="radar-refresh-btn"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Refreshing...' : 'Refresh Targets'}
          </button>

          {sessions.length > 1 && (
            <select
              className="radar-select-input"
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              id="radar-session-select"
            >
              <option value="ALL">All Aircraft Tracks ({aircraftList.length})</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name.length > 34 ? `${s.name.slice(0, 34)}...` : s.name}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            className="radar-btn"
            onClick={() => navigate('/ledger')}
            title="Open comprehensive audit ledger"
          >
            Open Ledger
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Main Layout: Scope + Aircraft Inspector */}
      <div className="radar-layout">
        {/* Radar Scope Frame (Dark CRT display) */}
        <div className="radar-scope-card" id="radar-scope-card">
          {/* Floating Layers Panel (HUD) */}
          <div className="radar-layers-hud">
            <div className="radar-hud-title">
              <Layers size={13} />
              Display Layers
            </div>

            <label className="radar-hud-toggle">
              <input
                type="checkbox"
                checked={showTargets}
                onChange={(e) => setShowTargets(e.target.checked)}
              />
              Aircraft Targets ({filteredAircraft.length})
            </label>

            <label className="radar-hud-toggle">
              <input
                type="checkbox"
                checked={showRangeRings}
                onChange={(e) => setShowRangeRings(e.target.checked)}
              />
              Range Rings (25 NM)
            </label>

            <label className="radar-hud-toggle">
              <input
                type="checkbox"
                checked={showRunways}
                onChange={(e) => setShowRunways(e.target.checked)}
              />
              Runways & Approach
            </label>

            <label className="radar-hud-toggle">
              <input
                type="checkbox"
                checked={showSweep}
                onChange={(e) => setShowSweep(e.target.checked)}
              />
              Sweeper Beam & Trail
            </label>

            <label className="radar-hud-toggle">
              <input
                type="checkbox"
                checked={showWaypoints}
                onChange={(e) => setShowWaypoints(e.target.checked)}
              />
              Terminal Fixes & Waypoints
            </label>
          </div>

          {/* Radar Palette Theme Switcher */}
          <div className="radar-palette-hud" title="Radar Phosphor Theme">
            <button
              type="button"
              className={`radar-palette-btn ${radarTheme === 'green' ? 'is-active' : ''}`}
              style={{ background: '#00ff88', color: '#00ff88' }}
              onClick={() => setRadarTheme('green')}
              title="Phosphor Green (Classic FAA TRACON)"
              aria-label="Phosphor Green Theme"
            />
            <button
              type="button"
              className={`radar-palette-btn ${radarTheme === 'cyan' ? 'is-active' : ''}`}
              style={{ background: '#00e5ff', color: '#00e5ff' }}
              onClick={() => setRadarTheme('cyan')}
              title="Modern Cyan (Eurocontrol / NexGen)"
              aria-label="Modern Cyan Theme"
            />
            <button
              type="button"
              className={`radar-palette-btn ${radarTheme === 'amber' ? 'is-active' : ''}`}
              style={{ background: '#ffaa00', color: '#ffaa00' }}
              onClick={() => setRadarTheme('amber')}
              title="Monochrome Amber (Warm CRT)"
              aria-label="Monochrome Amber Theme"
            />
          </div>

          {/* Interactive Canvas */}
          <canvas
            ref={canvasRef}
            className="radar-canvas"
            onClick={handleCanvasClick}
            id="radar-scope-canvas"
          />

          {/* Corner Caption (MANDATORY REQUIREMENT) */}
          <div className="radar-simulation-caption">
            <span className="radar-sim-tag">
              Simulated positions
            </span>
            <span className="radar-telemetry-tag">
              RADAR SWEEP: 3.5s · RANGE: 25 NM · SFO TRACON
            </span>
          </div>
        </div>

        {/* Side Aircraft Inspector Panel */}
        <div className="radar-inspector-card">
          <div className="radar-inspector-header">
            <div className="radar-inspector-title">
              <Plane size={16} />
              Aircraft Target Inspector
            </div>
            {activeAircraft && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  fontWeight: 700,
                  color:
                    activeAircraft.latest_outcome === 'MATCH'
                      ? 'var(--accent-match)'
                      : activeAircraft.latest_outcome === 'MISMATCH'
                      ? 'var(--accent-critical)'
                      : 'var(--text-secondary)',
                }}
              >
                {activeAircraft.latest_outcome}
              </span>
            )}
          </div>

          <div className="radar-inspector-body">
            {activeAircraft ? (
              <>
                <div className="radar-target-header">
                  <div>
                    <div className="radar-target-callsign">
                      {activeAircraft.callsign}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {activeAircraft.scenario_name}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="radar-btn"
                    style={{ padding: '4px 8px', fontSize: '11px' }}
                    onClick={() => navigate(`/ledger`)}
                    title="View all records for this aircraft in the Ledger"
                  >
                    Ledger
                    <ExternalLink size={12} />
                  </button>
                </div>

                {/* Telemetry Grid */}
                <div className="radar-telemetry-grid">
                  <div className="radar-telemetry-box">
                    <span className="radar-telemetry-label">Assigned Altitude</span>
                    <span className="radar-telemetry-value">{activeAircraft.assigned_altitude} FT</span>
                  </div>

                  <div className="radar-telemetry-box">
                    <span className="radar-telemetry-label">Assigned Heading</span>
                    <span className="radar-telemetry-value">{activeAircraft.assigned_heading}°</span>
                  </div>

                  <div className="radar-telemetry-box">
                    <span className="radar-telemetry-label">Active Runway</span>
                    <span className="radar-telemetry-value">RWY {activeAircraft.assigned_runway}</span>
                  </div>

                  <div className="radar-telemetry-box">
                    <span className="radar-telemetry-label">Assigned Squawk</span>
                    <span className="radar-telemetry-value">{activeAircraft.assigned_squawk}</span>
                  </div>
                </div>

                {/* Last Preceding Instruction */}
                <div className="radar-instruction-block">
                  <span className="radar-block-label">Last Controller Instruction</span>
                  <div className="radar-block-content">
                    {activeAircraft.latest_instruction}
                  </div>
                </div>

                {/* Last Pilot Readback */}
                <div className="radar-instruction-block">
                  <span className="radar-block-label">Last Pilot Read-Back</span>
                  <div className="radar-block-content" style={{ fontWeight: 500 }}>
                    {activeAircraft.latest_readback}
                  </div>
                </div>

                {/* Safety Sentinel Verdict */}
                <div className="radar-instruction-block">
                  <span className="radar-block-label">Safety Sentinel Verdict</span>
                  <div
                    className={`radar-verdict-box ${
                      activeAircraft.latest_outcome === 'MATCH'
                        ? 'radar-verdict-match'
                        : activeAircraft.latest_outcome === 'MISMATCH'
                        ? 'radar-verdict-mismatch'
                        : 'radar-verdict-unverified'
                    }`}
                  >
                    <div style={{ fontWeight: 700, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {activeAircraft.latest_outcome === 'MATCH' ? (
                        <ShieldCheck size={14} />
                      ) : activeAircraft.latest_outcome === 'MISMATCH' ? (
                        <AlertOctagon size={14} />
                      ) : (
                        <HelpCircle size={14} />
                      )}
                      {activeAircraft.latest_outcome} · {activeAircraft.latest_severity}
                    </div>
                    <div>{activeAircraft.latest_explanation || 'Readback evaluated deterministically against clearance.'}</div>
                  </div>
                </div>

                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  Total clearances recorded: {activeAircraft.total_verdicts}
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)' }}>
                <Plane size={28} strokeWidth={1.5} style={{ margin: '0 auto 8px auto', opacity: 0.5 }} />
                <div style={{ fontWeight: 600, fontSize: '13px' }}>No aircraft target selected</div>
                <div style={{ fontSize: '12px', marginTop: '4px' }}>Click any blip on the radar scope or select from the target queue below.</div>
              </div>
            )}

            {/* Target Queue List */}
            <div style={{ marginTop: 'var(--space-2)' }}>
              <span className="radar-block-label" style={{ marginBottom: '8px', display: 'block' }}>
                Tracked Airspace Targets ({filteredAircraft.length})
              </span>
              <div className="radar-targets-list">
                {filteredAircraft.map((ac) => (
                  <div
                    key={ac.callsign}
                    className={`radar-target-item ${ac.callsign === selectedCallsign ? 'is-selected' : ''}`}
                    onClick={() => setSelectedCallsign(ac.callsign)}
                  >
                    <div className="radar-target-callsign-sm">
                      <Plane size={13} />
                      {ac.callsign}
                    </div>
                    <div className="radar-target-meta-sm">
                      FL{Math.round(Number(ac.assigned_altitude || 3000) / 100)} · {ac.assigned_heading}°
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
