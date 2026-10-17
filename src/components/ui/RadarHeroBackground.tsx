import { useEffect, useRef } from 'react';

interface AircraftBlip {
  callsign: string;
  altitude: string;
  heading: number;
  distRatio: number;
  angle: number;
  speed: number;
}

interface RadarProps {
  theme?: 'light' | 'dark';
  opacity?: number;
}

export function RadarHeroBackground({ theme = 'light', opacity = 0.85 }: RadarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let animationFrameId: number;
    let sweepAngle = 0;

    // Simulated aircraft blips
    const aircraft: AircraftBlip[] = [
      { callsign: 'BAW214', altitude: 'FL100', heading: 270, distRatio: 0.35, angle: -0.85, speed: 0.00012 },
      { callsign: 'DLH402', altitude: 'FL330', heading: 280, distRatio: 0.55, angle: 0.65, speed: 0.00010 },
      { callsign: 'AAL731', altitude: 'FL270', heading: 180, distRatio: 0.72, angle: 1.45, speed: 0.00014 },
      { callsign: 'AFR318', altitude: 'FL120', heading: 90, distRatio: 0.65, angle: -2.2, speed: 0.00011 },
      { callsign: 'SIA317', altitude: 'FL060', heading: 120, distRatio: 0.82, angle: 2.4, speed: 0.00009 },
      { callsign: 'UAL620', altitude: 'FL280', heading: 250, distRatio: 0.45, angle: -2.9, speed: 0.00013 },
    ];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.parentElement?.clientWidth || window.innerWidth;
      const height = canvas.parentElement?.clientHeight || window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    const isLight = theme === 'light';

    // Calibrated subtle aerospace colors for light background
    const ringColor = isLight ? 'rgba(10, 10, 14, 0.11)' : 'rgba(255, 255, 255, 0.08)';
    const ringLabelColor = isLight ? 'rgba(10, 10, 14, 0.40)' : 'rgba(255, 255, 255, 0.35)';
    const axisColor = isLight ? 'rgba(10, 10, 14, 0.08)' : 'rgba(255, 255, 255, 0.06)';
    const cardinalColor = isLight ? 'rgba(10, 10, 14, 0.45)' : 'rgba(255, 255, 255, 0.45)';
    const runwayColor = isLight ? 'rgba(10, 10, 14, 0.22)' : 'rgba(255, 255, 255, 0.25)';
    const sweepLineColor = isLight ? 'rgba(10, 10, 14, 0.28)' : 'rgba(255, 255, 255, 0.45)';

    const render = () => {
      const width = canvas.width / (window.devicePixelRatio || 1);
      const height = canvas.height / (window.devicePixelRatio || 1);
      const cx = width / 2;
      const cy = height * 0.42; // Centered behind central video subject
      const maxRadius = Math.max(width * 0.54, height * 0.65);

      // Clear canvas (transparent to blend seamlessly on white)
      ctx.clearRect(0, 0, width, height);

      ctx.save();

      // 1. Concentric Range Rings (10, 20, 30, 40, 50 NM)
      const ringSteps = [0.2, 0.4, 0.6, 0.8, 1.0];
      const nmLabels = ['10 NM', '20 NM', '30 NM', '40 NM', '50 NM'];

      ringSteps.forEach((step, idx) => {
        const r = maxRadius * step;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = '9px Inter, monospace';
        ctx.fillStyle = ringLabelColor;
        ctx.textAlign = 'left';
        ctx.fillText(nmLabels[idx], cx + 6, cy - r + 12);
      });

      // 2. Compass Crosshairs & Cardinal Labels
      ctx.strokeStyle = axisColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - maxRadius, cy);
      ctx.lineTo(cx + maxRadius, cy);
      ctx.moveTo(cx, cy - maxRadius);
      ctx.lineTo(cx, cy + maxRadius);
      ctx.stroke();

      ctx.font = '9.5px Inter, monospace';
      ctx.fillStyle = cardinalColor;
      ctx.textAlign = 'center';
      ctx.fillText('360° N', cx, cy - maxRadius * 0.94);
      ctx.fillText('180° S', cx, cy + maxRadius * 0.94);
      ctx.textAlign = 'right';
      ctx.fillText('270° W', cx - maxRadius * 0.92, cy - 6);
      ctx.textAlign = 'left';
      ctx.fillText('090° E', cx + maxRadius * 0.92, cy - 6);

      // 3. Runway Complex Glyph
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.35);
      ctx.strokeStyle = runwayColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-45, -7);
      ctx.lineTo(45, -7);
      ctx.moveTo(-48, 10);
      ctx.lineTo(42, 10);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-15, -30);
      ctx.lineTo(15, 30);
      ctx.stroke();
      // Center beacon
      ctx.beginPath();
      ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isLight ? 'rgba(10, 10, 14, 0.4)' : 'rgba(255, 255, 255, 0.7)';
      ctx.fill();
      ctx.restore();

      // 4. Radar Sweep Beam + Restrained Soft Trail
      const sweepSegments = 30;
      const trailAngle = 0.45;
      for (let i = 0; i < sweepSegments; i++) {
        const segFrac = i / sweepSegments;
        const a1 = sweepAngle - (trailAngle * (1 - segFrac));
        const a2 = sweepAngle - (trailAngle * (1 - (i + 1) / sweepSegments));
        const alpha = Math.pow(segFrac, 2) * (isLight ? 0.03 : 0.06);

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, maxRadius, a1, a2);
        ctx.closePath();
        ctx.fillStyle = isLight ? `rgba(10, 10, 14, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
        ctx.fill();
      }

      // Leading sweep line
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweepAngle) * maxRadius, cy + Math.sin(sweepAngle) * maxRadius);
      ctx.strokeStyle = sweepLineColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      // 5. Simulated Aircraft Blips & Flight Tags
      aircraft.forEach((craft) => {
        craft.angle += craft.speed;
        const x = cx + Math.cos(craft.angle) * (maxRadius * craft.distRatio);
        const y = cy + Math.sin(craft.angle) * (maxRadius * craft.distRatio);

        let angleDiff = (sweepAngle - craft.angle) % (Math.PI * 2);
        if (angleDiff < 0) angleDiff += Math.PI * 2;
        const isFreshlySwept = angleDiff < 0.55;
        const flare = isFreshlySwept ? Math.max(0.3, 1 - angleDiff / 0.55) : 0.2;

        ctx.save();
        ctx.translate(x, y);

        // Blip core
        ctx.beginPath();
        ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = isLight
          ? `rgba(10, 10, 14, ${Math.min(0.9, flare + 0.35)})`
          : `rgba(255, 255, 255, ${Math.min(1, flare + 0.3)})`;
        ctx.fill();

        // Heading arrow vector
        const headingRad = (craft.heading - 90) * (Math.PI / 180);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(headingRad) * 12, Math.sin(headingRad) * 12);
        ctx.strokeStyle = isLight
          ? `rgba(10, 10, 14, ${Math.max(0.25, flare * 0.5)})`
          : `rgba(255, 255, 255, ${flare * 0.4})`;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Flight data tag
        ctx.font = '9px Inter, monospace';
        ctx.fillStyle = isLight
          ? `rgba(10, 10, 14, ${Math.max(0.45, flare * 0.85)})`
          : `rgba(255, 255, 255, ${Math.max(0.3, flare * 0.8)})`;
        ctx.textAlign = 'left';
        ctx.fillText(craft.callsign, 8, -3);
        ctx.font = '8px Inter, monospace';
        ctx.fillStyle = isLight
          ? `rgba(10, 10, 14, ${Math.max(0.3, flare * 0.6)})`
          : `rgba(255, 255, 255, ${Math.max(0.2, flare * 0.5)})`;
        ctx.fillText(`${craft.altitude}`, 8, 7);

        ctx.restore();
      });

      ctx.restore();

      sweepAngle = (sweepAngle + 0.009) % (Math.PI * 2);
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [theme]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        opacity,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        }}
      />
    </div>
  );
}
