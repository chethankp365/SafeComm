import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Radar,
  RefreshCw,
  Plane,
  ExternalLink,
  ChevronRight,
  AlertOctagon,
  Globe,
  Compass,
  Camera,
  AlertCircle,
} from 'lucide-react';
import {
  fetchLiveNearbyAircraft,
  calculateRadarCanvasPosition,
  RADAR_CENTERS,
  type LiveAircraft,
  type RadarCenterConfig,
} from '../lib/aircraftService';
import {
  fetchRadarScopeAircraft,
  calculateDeterministicRadarPosition,
  type RadarAircraft,
} from '../lib/ledgerService';
import {
  fetchAircraftPhoto,
  type AircraftPhotoData,
} from '../lib/aircraftPhotoService';
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

// Navigational fixes around terminal airspace
const WAYPOINTS = [
  { name: 'ARCHI', angle: 45, radius: 0.75 },
  { name: 'EDDYY', angle: 125, radius: 0.65 },
  { name: 'CEPIN', angle: 215, radius: 0.70 },
  { name: 'DUMBA', angle: 300, radius: 0.80 },
  { name: 'BRIXX', angle: 165, radius: 0.40 },
  { name: 'MENLO', angle: 260, radius: 0.50 },
];

function getCardinalDirection(deg: number): string {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return directions[index];
}

export const RadarMap: React.FC = () => {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Operational Data Mode: LIVE ADS-B (real) or SIMULATED SCENARIO (SafeComm test records)
  const [dataMode, setDataMode] = useState<'live' | 'simulated'>('live');

  // Configured Radar Center & Range (10 NM default as required by Task 1.1)
  const [selectedCenterId, setSelectedCenterId] = useState<string>('KSFO');
  const [rangeNM, setRangeNM] = useState<number>(10);

  const activeCenter: RadarCenterConfig = useMemo(() => {
    return RADAR_CENTERS.find((c) => c.id === selectedCenterId) || RADAR_CENTERS[0];
  }, [selectedCenterId]);

  // Live ADS-B Aircraft State
  const [liveAircraftList, setLiveAircraftList] = useState<LiveAircraft[]>([]);
  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [lastFetchTime, setLastFetchTime] = useState<string | null>(null);
  const [isStaleData, setIsStaleData] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Photo Enrichment State
  const [photoData, setPhotoData] = useState<AircraftPhotoData | null>(null);
  const [photoLoading, setPhotoLoading] = useState<boolean>(false);

  // Simulated Supabase Aircraft State (for fallback / scenario review)
  const [simulatedList, setSimulatedList] = useState<RadarAircraft[]>([]);
  const [selectedSimCallsign, setSelectedSimCallsign] = useState<string | null>(null);

  // Radar Scope Visual Theme
  const [radarTheme, setRadarTheme] = useState<RadarTheme>('green');

  // Filter live aircraft strictly within the active display range
  const inRangeLiveAircraft = useMemo(() => {
    return liveAircraftList.filter((a) => a.distanceNM <= rangeNM);
  }, [liveAircraftList, rangeNM]);

  // Active selected Live aircraft (persists selection across range changes)
  const activeLiveAircraft = useMemo(() => {
    if (selectedHex) {
      const match = liveAircraftList.find((a) => a.hex === selectedHex);
      if (match) return match;
    }
    return inRangeLiveAircraft[0] || liveAircraftList[0] || null;
  }, [liveAircraftList, inRangeLiveAircraft, selectedHex]);

  // Verify if selected target is currently within the active display range
  const isSelectedInRange = useMemo(() => {
    if (!activeLiveAircraft) return true;
    return activeLiveAircraft.distanceNM <= rangeNM;
  }, [activeLiveAircraft, rangeNM]);

  // Active selected Simulated aircraft
  const activeSimulatedAircraft = useMemo(() => {
    return simulatedList.find((a) => a.callsign === selectedSimCallsign) || simulatedList[0] || null;
  }, [simulatedList, selectedSimCallsign]);

  // Fetch Live ADS-B Aircraft (10-second conservative refresh interval)
  const loadLiveAircraft = useCallback(async (isManual: boolean = false) => {
    if (isManual) setLoading(true);
    setFetchError(null);

    const controller = new AbortController();
    const result = await fetchLiveNearbyAircraft(
      activeCenter.lat,
      activeCenter.lon,
      rangeNM,
      controller.signal
    );

    if (result.error && result.aircraft.length === 0) {
      setFetchError(result.error);
      setIsStaleData(false);
    } else {
      setLiveAircraftList(result.aircraft);
      setIsStaleData(result.isStale);
      setLastFetchTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

      // Preserve selection if hex still in response, else default to first in range
      setSelectedHex((prevHex) => {
        if (prevHex && result.aircraft.some((a) => a.hex === prevHex)) {
          return prevHex;
        }
        const firstInRange = result.aircraft.find((a) => a.distanceNM <= rangeNM);
        return firstInRange ? firstInRange.hex : (result.aircraft[0]?.hex || null);
      });
    }

    setLoading(false);
  }, [activeCenter, rangeNM]);

  // Load Simulated Supabase aircraft if requested
  const loadSimulatedAircraft = useCallback(async () => {
    setLoading(true);
    const res = await fetchRadarScopeAircraft();
    if (res.aircraft) {
      setSimulatedList(res.aircraft);
      if (res.aircraft.length > 0 && !selectedSimCallsign) {
        setSelectedSimCallsign(res.aircraft[0].callsign);
      }
    }
    setLoading(false);
  }, [selectedSimCallsign]);

  // Initial and periodic refresh lifecycle
  useEffect(() => {
    let isMounted = true;

    if (dataMode === 'live') {
      void loadLiveAircraft(true);
      // 10-second interval complies with adsb.fi rate-limit (max 1 req/sec)
      const interval = setInterval(() => {
        if (isMounted) void loadLiveAircraft(false);
      }, 10000);
      return () => {
        isMounted = false;
        clearInterval(interval);
      };
    } else {
      void loadSimulatedAircraft();
    }
  }, [dataMode, loadLiveAircraft, loadSimulatedAircraft]);

  // Fetch photo enrichment when active live aircraft changes
  useEffect(() => {
    if (dataMode !== 'live' || !activeLiveAircraft?.hex) {
      setPhotoData(null);
      setPhotoLoading(false);
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    setPhotoLoading(true);
    setPhotoData(null);

    fetchAircraftPhoto(activeLiveAircraft.hex, activeLiveAircraft.registration, controller.signal)
      .then((photo) => {
        if (isMounted) {
          setPhotoData(photo);
          setPhotoLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) {
          setPhotoData(null);
          setPhotoLoading(false);
        }
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [activeLiveAircraft?.hex, activeLiveAircraft?.registration, dataMode]);

  // Sweep rotation & interactive target hit tracking
  const sweepAngleRef = useRef(0);
  const targetCoordinatesRef = useRef<Map<string, { x: number; y: number; r: number }>>(new Map());

  // Canvas Scope Render Loop
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

      // Sweep rotates 1 full revolution every ~3.5 seconds
      sweepAngleRef.current = (sweepAngleRef.current + (dt * Math.PI * 2) / 3.5) % (Math.PI * 2);

      // HiDPI resolution handling
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

      // 2. Radar Range Rings & Azimuth Grid (Always active core display)
      ctx.strokeStyle = palette.gridLine;
      ctx.lineWidth = 1;

      // Concentric distance rings based on active rangeNM
      const ringSteps = [0.2, 0.4, 0.6, 0.8, 1.0];
      ringSteps.forEach((factor) => {
        const r = maxRadius * factor;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();

        // Distance label in nautical miles
        const distLabel = `${Math.round(rangeNM * factor)} NM`;
        ctx.fillStyle = palette.gridText;
        ctx.font = '10px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(distLabel, cx + 4, cy - r + 12);
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

      // 3. Runway Centerlines & Terminal Layout
      ctx.save();
      ctx.translate(cx, cy);

      const rwAngle = (-76 * Math.PI) / 180;
      ctx.rotate(rwAngle);

      ctx.fillStyle = palette.runway;
      ctx.fillRect(-6, -30, 4, 60);
      ctx.strokeStyle = palette.runwayMarking;
      ctx.lineWidth = 1;
      ctx.strokeRect(-6, -30, 4, 60);

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

      ctx.fillStyle = palette.runwayMarking;
      ctx.font = 'bold 9px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('28L', -4, -36);
      ctx.fillText('28R', 6, -40);

      ctx.restore();

      // 4. Navigation Waypoints
      WAYPOINTS.forEach((wp) => {
        const rad = (wp.angle * Math.PI) / 180;
        const wx = cx + maxRadius * wp.radius * Math.sin(rad);
        const wy = cy - maxRadius * wp.radius * Math.cos(rad);

        ctx.strokeStyle = palette.waypoint;
        ctx.fillStyle = palette.waypoint;
        ctx.beginPath();
        ctx.moveTo(wx, wy - 4);
        ctx.lineTo(wx + 4, wy + 4);
        ctx.lineTo(wx - 4, wy + 4);
        ctx.closePath();
        ctx.stroke();

        ctx.font = '9px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(wp.name, wx, wy + 13);
      });

      // 5. Sweeping Radar Line with Phosphor Afterglow
      const sweepAngle = sweepAngleRef.current;
      const sweepX = cx + maxRadius * Math.sin(sweepAngle);
      const sweepY = cy - maxRadius * Math.cos(sweepAngle);

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

      ctx.strokeStyle = palette.sweepLine;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sweepX, sweepY);
      ctx.stroke();

      // 6. Target Plotting (Clutter-Controlled Label Prioritization)
      targetCoordinatesRef.current.clear();

      if (dataMode === 'live' && inRangeLiveAircraft.length > 0) {
        // Step A: Draw all in-range target blips & register interactive hit areas
        inRangeLiveAircraft.forEach((ac) => {
          const pos = calculateRadarCanvasPosition(
            activeCenter.lat,
            activeCenter.lon,
            ac.lat,
            ac.lon,
            rangeNM,
            maxRadius
          );
          if (!pos.inRange) return;

          const bx = cx + pos.x;
          const by = cy + pos.y;
          targetCoordinatesRef.current.set(ac.hex, { x: bx, y: by, r: 16 });

          const isSelected = ac.hex === selectedHex;
          const isGround = ac.altBaro === 'ground';

          ctx.save();
          ctx.translate(bx, by);

          // Refined Selection Reticle
          if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(0, 0, 11, 0, Math.PI * 2);
            ctx.stroke();

            ctx.strokeStyle = palette.targetBlip;
            ctx.lineWidth = 1;
            ctx.strokeRect(-13, -13, 26, 26);
          }

          // Aircraft Blip Symbol
          ctx.fillStyle = isSelected ? '#ffffff' : isGround ? '#94a3b8' : palette.targetBlip;
          ctx.beginPath();
          ctx.rect(-3.5, -3.5, 7, 7);
          ctx.fill();

          // Velocity Vector Line (Only drawn if track exists; never fabricated)
          if (ac.track !== null && !isGround) {
            const hRad = ((ac.track - 90) * Math.PI) / 180;
            const vectorLen = 22;
            ctx.strokeStyle = isSelected ? '#ffffff' : palette.targetBlip;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(vectorLen * Math.cos(hRad), vectorLen * Math.sin(hRad));
            ctx.stroke();
          }

          ctx.restore();
        });

        // Step B: Prioritize targets for Flight Data Block (FDB) labels (max 6-8 labels)
        const MAX_FDB_LABELS = 8;
        const labelCandidates = [...inRangeLiveAircraft].sort((a, b) => {
          if (a.hex === selectedHex) return -1;
          if (b.hex === selectedHex) return 1;
          return a.distanceNM - b.distanceNM;
        });

        // Step C: Collision-avoidance placement algorithm
        const placedBoxes: { x: number; y: number; w: number; h: number }[] = [];
        const fdbW = 66;
        const fdbH = 26;

        labelCandidates.forEach((ac) => {
          const isSelected = ac.hex === selectedHex;
          if (placedBoxes.length >= MAX_FDB_LABELS && !isSelected) return;

          const pos = calculateRadarCanvasPosition(
            activeCenter.lat,
            activeCenter.lon,
            ac.lat,
            ac.lon,
            rangeNM,
            maxRadius
          );
          if (!pos.inRange) return;

          const bx = cx + pos.x;
          const by = cy + pos.y;

          // 4 candidate placement quadrants around target blip
          const candidateOffsets = [
            { ox: 14, oy: -26 },  // Top-Right
            { ox: 14, oy: 10 },   // Bottom-Right
            { ox: -74, oy: -26 }, // Top-Left
            { ox: -74, oy: 10 },  // Bottom-Left
          ];

          let chosenBox: { x: number; y: number; w: number; h: number } | null = null;

          for (const off of candidateOffsets) {
            const boxX = bx + off.ox;
            const boxY = by + off.oy;

            // Stay within visible canvas bounds
            if (boxX < 12 || boxX + fdbW > width - 12 || boxY < 12 || boxY + fdbH > height - 12) {
              continue;
            }

            // Check collision with already placed labels (4px safety margin)
            const collides = placedBoxes.some(
              (p) =>
                boxX < p.x + p.w + 4 &&
                boxX + fdbW + 4 > p.x &&
                boxY < p.y + p.h + 4 &&
                boxY + fdbH + 4 > p.y
            );

            if (!collides) {
              chosenBox = { x: boxX, y: boxY, w: fdbW, h: fdbH };
              break;
            }
          }

          // The selected target is guaranteed a label even in dense clusters
          if (!chosenBox && isSelected) {
            chosenBox = { x: bx + 14, y: by - 26, w: fdbW, h: fdbH };
          }

          if (chosenBox) {
            placedBoxes.push(chosenBox);

            // Connecting Leader Line
            ctx.strokeStyle = isSelected ? '#ffffff' : palette.gridLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(
              chosenBox.x > bx ? chosenBox.x : chosenBox.x + fdbW,
              chosenBox.y + fdbH / 2
            );
            ctx.stroke();

            // Background Pill
            ctx.fillStyle = palette.dataBlockBg;
            ctx.strokeStyle = isSelected ? '#ffffff' : palette.gridLine;
            ctx.lineWidth = isSelected ? 1.5 : 1;
            ctx.fillRect(chosenBox.x, chosenBox.y, fdbW, fdbH);
            ctx.strokeRect(chosenBox.x, chosenBox.y, fdbW, fdbH);

            // Line 1: Callsign or Hex
            ctx.font = 'bold 9px ui-monospace, Consolas, monospace';
            ctx.fillStyle = isSelected ? '#ffffff' : palette.dataBlockText;
            ctx.textAlign = 'left';
            const displayCallsign = ac.callsign.length > 8 ? ac.callsign.slice(0, 8) : ac.callsign;
            ctx.fillText(displayCallsign, chosenBox.x + 4, chosenBox.y + 10);

            // Line 2: Altitude + Groundspeed
            let altDisplay = '---';
            if (ac.altBaro === 'ground') {
              altDisplay = 'GND';
            } else if (typeof ac.altBaro === 'number') {
              altDisplay = `FL${String(Math.round(ac.altBaro / 100)).padStart(3, '0')}`;
            }
            const spdDisplay = ac.groundSpeed !== null ? `${Math.round(ac.groundSpeed)}k` : '';
            ctx.font = '8px ui-monospace, Consolas, monospace';
            ctx.fillStyle = palette.gridText;
            ctx.fillText(`${altDisplay} ${spdDisplay}`.trim(), chosenBox.x + 4, chosenBox.y + 20);
          }
        });
      } else if (dataMode === 'simulated' && simulatedList.length > 0) {
        simulatedList.forEach((ac) => {
          const pos = calculateDeterministicRadarPosition(
            ac.callsign,
            ac.session_id,
            ac.assigned_heading
          );
          const rad = (pos.angleDeg * Math.PI) / 180;
          const bx = cx + maxRadius * pos.radiusFactor * Math.sin(rad);
          const by = cy - maxRadius * pos.radiusFactor * Math.cos(rad);

          targetCoordinatesRef.current.set(ac.callsign, { x: bx, y: by, r: 16 });
          const isSelected = ac.callsign === selectedSimCallsign;

          ctx.save();
          ctx.translate(bx, by);

          if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(0, 0, 11, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = palette.targetBlip;
            ctx.lineWidth = 1;
            ctx.strokeRect(-12, -12, 24, 24);
          }

          const isMismatch = ac.latest_outcome === 'MISMATCH';
          ctx.fillStyle = isMismatch ? '#ff3b30' : isSelected ? '#ffffff' : palette.targetBlip;
          ctx.beginPath();
          ctx.rect(-3.5, -3.5, 7, 7);
          ctx.fill();

          const hRad = ((pos.headingDeg - 90) * Math.PI) / 180;
          ctx.strokeStyle = isMismatch ? '#ff3b30' : palette.targetBlip;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(22 * Math.cos(hRad), 22 * Math.sin(hRad));
          ctx.stroke();

          ctx.restore();

          const fdbX = bx + 14;
          const fdbY = by - 24;
          ctx.fillStyle = palette.dataBlockBg;
          ctx.strokeStyle = isSelected ? '#ffffff' : palette.gridLine;
          ctx.lineWidth = 1;
          ctx.fillRect(fdbX, fdbY, 68, 26);
          ctx.strokeRect(fdbX, fdbY, 68, 26);

          ctx.font = 'bold 9px ui-monospace, Consolas, monospace';
          ctx.fillStyle = isSelected ? '#ffffff' : palette.dataBlockText;
          ctx.textAlign = 'left';
          ctx.fillText(ac.callsign, fdbX + 4, fdbY + 10);

          ctx.font = '8px ui-monospace, Consolas, monospace';
          ctx.fillStyle = palette.gridText;
          ctx.fillText(`FL${Math.round(Number(ac.assigned_altitude || 3000) / 100)} H${ac.assigned_heading || '090'}`, fdbX + 4, fdbY + 20);
        });
      }

      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrameId);
  }, [
    radarTheme,
    dataMode,
    inRangeLiveAircraft,
    simulatedList,
    selectedHex,
    selectedSimCallsign,
    rangeNM,
    activeCenter,
  ]);

  // Click on radar canvas to select aircraft target
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    for (const [targetKey, coords] of targetCoordinatesRef.current.entries()) {
      const dist = Math.hypot(clickX - coords.x, clickY - coords.y);
      if (dist <= 24) {
        if (dataMode === 'live') {
          setSelectedHex(targetKey);
        } else {
          setSelectedSimCallsign(targetKey);
        }
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
            {dataMode === 'live' ? (
              <span className={`radar-mode-badge ${isStaleData ? 'stale' : 'live'}`}>
                <span className="radar-pulse-dot" />
                {isStaleData ? 'STALE ADS-B' : 'LIVE ADS-B'}
              </span>
            ) : (
              <span className="radar-mode-badge simulated">
                SIMULATED SCENARIO
              </span>
            )}
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
            Real-time aerospace terminal display plotting live ADS-B aircraft telemetry from adsb.fi.
          </p>
        </div>

        <div className="radar-header-controls">
          {/* Mode Switcher */}
          <select
            className="radar-select-input"
            value={dataMode}
            onChange={(e) => setDataMode(e.target.value as 'live' | 'simulated')}
            title="Switch radar surveillance mode"
          >
            <option value="live">Live ADS-B Airspace Feed</option>
            <option value="simulated">Simulated Scenario Records</option>
          </select>

          {/* Radar Center Selector */}
          <select
            className="radar-select-input"
            value={selectedCenterId}
            onChange={(e) => setSelectedCenterId(e.target.value)}
            title="Configured radar center location"
          >
            {RADAR_CENTERS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icao} · {c.name}
              </option>
            ))}
          </select>

          {/* Range NM Selector (Default: 10 NM) */}
          <select
            className="radar-select-input"
            value={rangeNM}
            onChange={(e) => setRangeNM(Number(e.target.value))}
            title="Radar scope nautical mile range"
          >
            <option value={10}>10 NM Range</option>
            <option value={25}>25 NM Range</option>
            <option value={40}>40 NM Range</option>
            <option value={60}>60 NM Range</option>
          </select>

          {/* Refresh Targets Button */}
          <button
            type="button"
            className="radar-btn"
            onClick={() => loadLiveAircraft(true)}
            disabled={loading}
            title="Refresh radar targets from ADS-B feed"
            id="radar-refresh-btn"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Refreshing...' : 'Refresh Targets'}
          </button>

          {/* Live Aerotrack Button (External Worldwide Globe Map) */}
          <a
            href="https://globe.adsb.fi/"
            target="_blank"
            rel="noopener noreferrer"
            className="radar-btn aerotrack-btn"
            title="Explore worldwide aircraft tracking on adsb.fi"
            aria-label="Open Live Aerotrack worldwide aircraft map"
          >
            <Globe size={13} />
            <span>Live Aerotrack</span>
            <ExternalLink size={12} />
          </a>

          {/* Open Ledger */}
          <button
            type="button"
            className="radar-btn"
            onClick={() => navigate('/ledger')}
            title="Open comprehensive audit ledger"
          >
            Ledger
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Main Layout: Scope + Aircraft Inspector */}
      <div className="radar-layout">
        {/* Radar Scope Frame (Dark CRT display) */}
        <div className="radar-scope-card" id="radar-scope-card">
          {/* Radar Palette Theme Switcher (Compact Phosphor HUD) */}
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

          {/* Corner Caption & Attribution */}
          <div className="radar-simulation-caption">
            <span className={`radar-sim-tag ${isStaleData ? 'stale' : ''}`}>
              <Compass size={11} />
              {dataMode === 'live'
                ? `${activeCenter.icao} TRACON · ${inRangeLiveAircraft.length} TARGETS IN RANGE (${liveAircraftList.length} IN AIRSPACE) · RANGE: ${rangeNM} NM`
                : `${activeCenter.icao} TRACON · ${simulatedList.length} TARGETS (SIMULATED)`}
            </span>

            <span className="radar-telemetry-tag">
              <span>{lastFetchTime ? `UPDATED ${lastFetchTime}` : 'INITIALIZING'}</span>
              <span>·</span>
              <span>
                Aircraft data provided by{' '}
                <a
                  href="https://adsb.fi/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="radar-attribution-link"
                >
                  adsb.fi
                </a>
              </span>
            </span>
          </div>
        </div>

        {/* Side Aircraft Inspector Panel (Redesigned Premium Aviation Inspector) */}
        <div className="radar-inspector-card">
          <div className="radar-inspector-header">
            <div className="radar-inspector-title">
              <Plane size={15} />
              Aircraft Target Inspector
            </div>

            {dataMode === 'live' && activeLiveAircraft && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: activeLiveAircraft.altBaro === 'ground' ? '#94a3b8' : '#10b981',
                }}
              >
                {activeLiveAircraft.altBaro === 'ground' ? 'SURFACE / GROUND' : 'AIRBORNE'}
              </span>
            )}
            {dataMode === 'simulated' && activeSimulatedAircraft && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: activeSimulatedAircraft.latest_outcome === 'MATCH' ? '#10b981' : '#f59e0b',
                }}
              >
                {activeSimulatedAircraft.latest_outcome}
              </span>
            )}
          </div>

          <div className="radar-inspector-body">
            {fetchError && dataMode === 'live' && liveAircraftList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px 16px', color: '#ef4444' }}>
                <AlertOctagon size={28} style={{ margin: '0 auto 8px' }} />
                <div style={{ fontWeight: 600, fontSize: '13px' }}>ADS-B Feed Unavailable</div>
                <div style={{ fontSize: '12px', marginTop: '4px', color: 'var(--text-secondary)' }}>
                  {fetchError}
                </div>
              </div>
            ) : dataMode === 'live' && activeLiveAircraft ? (
              <>
                {/* 1. Hero Aircraft Header */}
                <div className="radar-target-hero">
                  <div>
                    <div className="radar-hero-title-row">
                      <span className="radar-hero-callsign">{activeLiveAircraft.callsign}</span>
                      <span className={`radar-hero-live-pill ${activeLiveAircraft.altBaro === 'ground' ? 'ground' : ''}`}>
                        <span className="radar-pulse-dot" style={{ width: 5, height: 5 }} />
                        {activeLiveAircraft.altBaro === 'ground' ? 'ON GROUND' : 'LIVE ADS-B'}
                      </span>
                    </div>
                    <div className="radar-hero-subtitle">
                      {activeLiveAircraft.aircraftDesc || activeLiveAircraft.aircraftType || 'Civil Aircraft'}
                      {activeLiveAircraft.operator ? ` · ${activeLiveAircraft.operator}` : ''}
                    </div>
                  </div>

                  <a
                    href={`https://globe.adsb.fi/?icao=${activeLiveAircraft.hex.toLowerCase()}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="radar-track-globe-btn"
                    title="Track this specific aircraft on adsb.fi Globe"
                  >
                    Track
                    <ExternalLink size={11} />
                  </a>
                </div>

                {/* Range Boundary Alert (if target is outside active scope range) */}
                {!isSelectedInRange && (
                  <div className="radar-out-of-range-banner">
                    <AlertCircle size={14} style={{ flexShrink: 0 }} />
                    <span>
                      Target is outside the active {rangeNM} NM display range ({activeLiveAircraft.distanceNM} NM from {activeCenter.icao}). Expand range to view on radar scope.
                    </span>
                  </div>
                )}

                {/* 2. Aircraft Photo Area (Enriched with Planespotters.net + Fallback) */}
                <div className="radar-photo-card">
                  {photoLoading ? (
                    <div className="radar-photo-skeleton">
                      <Plane size={20} className="animate-pulse" />
                      <span>Matching aircraft photo...</span>
                    </div>
                  ) : photoData?.imageUrl ? (
                    <>
                      <img
                        src={photoData.imageUrl}
                        alt={`${activeLiveAircraft.callsign} aircraft`}
                        className="radar-photo-img"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={() => setPhotoData(null)}
                      />
                      {photoData.photographer && (
                        <a
                          href={photoData.sourceLink || `https://www.planespotters.net/photo/search?q=${activeLiveAircraft.registration || activeLiveAircraft.hex}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="radar-photo-credit"
                          title="View on Planespotters.net"
                        >
                          <Camera size={10} />
                          <span>{photoData.photographer}</span>
                          <ExternalLink size={9} />
                        </a>
                      )}
                    </>
                  ) : (
                    <div className="radar-photo-fallback">
                      <Plane size={28} strokeWidth={1.5} style={{ opacity: 0.6 }} />
                      <div className="radar-fallback-meta">
                        <span>{activeLiveAircraft.registration || activeLiveAircraft.hex}</span>
                        {activeLiveAircraft.aircraftType && <span>· {activeLiveAircraft.aircraftType}</span>}
                        {activeLiveAircraft.category && <span>· Cat {activeLiveAircraft.category}</span>}
                      </div>
                      <span className="radar-fallback-notice">
                        Verified photo unavailable for {activeLiveAircraft.registration || activeLiveAircraft.hex}
                      </span>
                    </div>
                  )}
                </div>

                {/* 3. Flight Telemetry Strip (4-Metric Aerospace KPI Strip) */}
                <div className="radar-telemetry-strip">
                  <div className="radar-metric-cell">
                    <span className="radar-metric-label">Baro Altitude</span>
                    <span className="radar-metric-val">
                      {activeLiveAircraft.altBaro === 'ground'
                        ? 'SURFACE'
                        : typeof activeLiveAircraft.altBaro === 'number'
                        ? `${activeLiveAircraft.altBaro.toLocaleString()} FT`
                        : '—'}
                    </span>
                    <span className="radar-metric-sub">
                      {typeof activeLiveAircraft.altGeom === 'number'
                        ? `Geom: ${activeLiveAircraft.altGeom.toLocaleString()} FT`
                        : 'Pressure ref'}
                    </span>
                  </div>

                  <div className="radar-metric-cell">
                    <span className="radar-metric-label">Ground Speed</span>
                    <span className="radar-metric-val">
                      {activeLiveAircraft.groundSpeed !== null
                        ? `${Math.round(activeLiveAircraft.groundSpeed)} KTS`
                        : '—'}
                    </span>
                    <span className="radar-metric-sub">Surface radar track</span>
                  </div>

                  <div className="radar-metric-cell">
                    <span className="radar-metric-label">Track / Heading</span>
                    <span className="radar-metric-val">
                      {activeLiveAircraft.track !== null ? `${activeLiveAircraft.track}°` : '—'}
                    </span>
                    <span className="radar-metric-sub">
                      {activeLiveAircraft.track !== null ? `${getCardinalDirection(activeLiveAircraft.track)} heading` : 'Bearing'}
                    </span>
                  </div>

                  <div className="radar-metric-cell">
                    <span className="radar-metric-label">Vertical Rate</span>
                    <span
                      className={`radar-metric-val ${
                        activeLiveAircraft.verticalRate && activeLiveAircraft.verticalRate > 200
                          ? 'climbing'
                          : activeLiveAircraft.verticalRate && activeLiveAircraft.verticalRate < -200
                          ? 'descending'
                          : ''
                      }`}
                    >
                      {activeLiveAircraft.verticalRate !== null
                        ? `${activeLiveAircraft.verticalRate > 0 ? '+' : ''}${activeLiveAircraft.verticalRate} FPM`
                        : 'LEVEL'}
                    </span>
                    <span className="radar-metric-sub">
                      {activeLiveAircraft.verticalRate && activeLiveAircraft.verticalRate > 200
                        ? '↑ Climbing'
                        : activeLiveAircraft.verticalRate && activeLiveAircraft.verticalRate < -200
                        ? '↓ Descending'
                        : 'Level flight'}
                    </span>
                  </div>
                </div>

                {/* 4. Technical Identity Specifications */}
                <div>
                  <div className="radar-section-header">Aircraft Identity</div>
                  <div className="radar-specs-table">
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">ICAO 24-bit Hex</span>
                      <span className="radar-specs-value">{activeLiveAircraft.hex}</span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Registration</span>
                      <span className="radar-specs-value">{activeLiveAircraft.registration || '—'}</span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Aircraft Model</span>
                      <span className="radar-specs-value">{activeLiveAircraft.aircraftType || '—'}</span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Wake / Category</span>
                      <span className="radar-specs-value">{activeLiveAircraft.category || '—'}</span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Assigned Squawk</span>
                      <span className="radar-specs-value">{activeLiveAircraft.squawk || '—'}</span>
                    </div>
                  </div>
                </div>

                {/* 5. Position & Freshness */}
                <div>
                  <div className="radar-section-header">Position &amp; Freshness</div>
                  <div className="radar-specs-table">
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Coordinates</span>
                      <span className="radar-specs-value">
                        {activeLiveAircraft.lat.toFixed(4)}°, {activeLiveAircraft.lon.toFixed(4)}°
                      </span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Range &amp; Bearing</span>
                      <span className="radar-specs-value">
                        {activeLiveAircraft.distanceNM} NM @ {activeLiveAircraft.bearingDeg}°
                      </span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Last Position Age</span>
                      <span className="radar-specs-value">
                        {activeLiveAircraft.seenPos !== null ? `${activeLiveAircraft.seenPos}s ago` : '< 1s ago'}
                      </span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Surveillance Source</span>
                      <span className="radar-specs-value">adsb.fi Open Data</span>
                    </div>
                  </div>
                </div>

                {/* 6. Subtle Surveillance Separation Disclaimer */}
                <div className="radar-inspector-disclaimer">
                  <strong>Surveillance Telemetry:</strong> Real-time broadcast positions from adsb.fi. Uncorrelated with SafeComm voice clearances or scenario verdicts.
                </div>
              </>
            ) : dataMode === 'simulated' && activeSimulatedAircraft ? (
              <>
                <div className="radar-target-hero">
                  <div>
                    <div className="radar-hero-title-row">
                      <span className="radar-hero-callsign">{activeSimulatedAircraft.callsign}</span>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '10px',
                          padding: '2px 7px',
                          borderRadius: '4px',
                          background:
                            activeSimulatedAircraft.latest_outcome === 'MATCH'
                              ? 'rgba(16, 185, 129, 0.15)'
                              : 'rgba(239, 68, 68, 0.15)',
                          color:
                            activeSimulatedAircraft.latest_outcome === 'MATCH' ? '#10b981' : '#ef4444',
                          fontWeight: 700,
                        }}
                      >
                        {activeSimulatedAircraft.latest_outcome}
                      </span>
                    </div>
                    <div className="radar-hero-subtitle">
                      {activeSimulatedAircraft.scenario_name || 'Simulated Comm Record'}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="radar-section-header">Assigned Clearances</div>
                  <div className="radar-specs-table">
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Assigned Altitude</span>
                      <span className="radar-specs-value">
                        {activeSimulatedAircraft.assigned_altitude
                          ? `${activeSimulatedAircraft.assigned_altitude} FT`
                          : '—'}
                      </span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Assigned Heading</span>
                      <span className="radar-specs-value">
                        {activeSimulatedAircraft.assigned_heading
                          ? `${activeSimulatedAircraft.assigned_heading}°`
                          : '—'}
                      </span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Assigned Runway</span>
                      <span className="radar-specs-value">
                        {activeSimulatedAircraft.assigned_runway || '—'}
                      </span>
                    </div>
                    <div className="radar-specs-row">
                      <span className="radar-specs-key">Assigned Squawk</span>
                      <span className="radar-specs-value">
                        {activeSimulatedAircraft.assigned_squawk || '—'}
                      </span>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="radar-section-header">Latest Communication</div>
                  <div style={{ fontSize: '12px', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>ATC Instruction:</div>
                      <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                        {activeSimulatedAircraft.latest_instruction || 'None recorded'}
                      </div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>Pilot Read-Back:</div>
                      <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                        {activeSimulatedAircraft.latest_readback || 'None recorded'}
                      </div>
                    </div>
                    {activeSimulatedAircraft.latest_explanation && (
                      <div style={{ color: 'var(--text-muted)', fontSize: '11px', fontStyle: 'italic' }}>
                        {activeSimulatedAircraft.latest_explanation}
                      </div>
                    )}
                  </div>
                </div>

                <div className="radar-inspector-disclaimer" style={{ borderColor: 'rgba(245, 158, 11, 0.4)' }}>
                  <strong>Simulated Scenario Track:</strong> Sourced from SafeComm test session records. Not real-time ADS-B surveillance.
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)' }}>
                <Plane size={28} strokeWidth={1.5} style={{ margin: '0 auto 8px auto', opacity: 0.5 }} />
                <div style={{ fontWeight: 600, fontSize: '13px' }}>No aircraft target selected</div>
                <div style={{ fontSize: '12px', marginTop: '4px' }}>Click any blip on the radar scope or select from the queue below.</div>
              </div>
            )}

            {/* Target Queue List (In-Range Display) */}
            <div style={{ marginTop: 'var(--space-2)' }}>
              <div className="radar-section-header">
                {dataMode === 'live'
                  ? `Targets in ${rangeNM} NM Range (${inRangeLiveAircraft.length})`
                  : `Simulated Scenario Targets (${simulatedList.length})`}
              </div>
              <div className="radar-targets-list">
                {dataMode === 'live' ? (
                  inRangeLiveAircraft.map((ac) => (
                    <div
                      key={ac.hex}
                      className={`radar-target-item ${ac.hex === selectedHex ? 'is-selected' : ''}`}
                      onClick={() => setSelectedHex(ac.hex)}
                    >
                      <div className="radar-target-callsign-sm">
                        <Plane size={12} />
                        {ac.callsign}
                      </div>
                      <div className="radar-target-meta-sm">
                        {ac.altBaro === 'ground' ? 'GND' : `${ac.altBaro || '---'}ft`} · {ac.distanceNM} NM
                      </div>
                    </div>
                  ))
                ) : (
                  simulatedList.map((ac) => (
                    <div
                      key={ac.callsign}
                      className={`radar-target-item ${ac.callsign === selectedSimCallsign ? 'is-selected' : ''}`}
                      onClick={() => setSelectedSimCallsign(ac.callsign)}
                    >
                      <div className="radar-target-callsign-sm">
                        <Plane size={12} />
                        {ac.callsign}
                      </div>
                      <div className="radar-target-meta-sm">
                        {ac.latest_outcome} · FL{Math.round(Number(ac.assigned_altitude || 3000) / 100)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
