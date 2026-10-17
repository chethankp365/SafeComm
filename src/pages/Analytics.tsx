import React, { useEffect, useState, useCallback } from 'react';
import {
  BarChart3,
  TrendingDown,
  Radio,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  RefreshCw,
  PieChart as PieIcon,
  ShieldCheck,
  AlertOctagon,
  Calendar,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { fetchSafetyAnalytics, type SafetyAnalyticsData } from '../lib/alertsAnalyticsService';
import './Analytics.css';

export const Analytics: React.FC = () => {
  const [analytics, setAnalytics] = useState<SafetyAnalyticsData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await fetchSafetyAnalytics();
    if (err) {
      setError(err);
    } else {
      setAnalytics(data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const totalTransmissions = analytics?.totalTransmissions ?? 0;
  const totalVerdicts = analytics?.totalVerdicts ?? 0;
  const errorRate = analytics?.errorRate ?? 0;
  const matchCount = analytics?.matchCount ?? 0;
  const mismatchCount = analytics?.mismatchCount ?? 0;
  const partialCount = analytics?.partialCount ?? 0;
  const unverifiedCount = analytics?.unverifiedCount ?? 0;
  const trendData = analytics?.trendData ?? [];
  const outcomeDistribution = (analytics?.outcomeDistribution ?? []).filter((slice) => slice.value > 0);

  // Custom Recharts LineChart Tooltip
  const renderTrendTooltip = (props: any) => {
    const { active, payload } = props;
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="recharts-custom-tooltip">
          <div className="recharts-tooltip-title">{data.sessionName}</div>
          <div className="recharts-tooltip-row">
            <span>Time:</span>
            <span style={{ fontWeight: 600 }}>{data.formattedDate}</span>
          </div>
          <div className="recharts-tooltip-row">
            <span>Error Rate:</span>
            <span style={{ color: '#ef4444', fontWeight: 700 }}>{data.errorRate}%</span>
          </div>
          <div className="recharts-tooltip-row">
            <span>Total Clearances:</span>
            <span>{data.total}</span>
          </div>
          <div className="recharts-tooltip-row">
            <span>Exact Matches:</span>
            <span style={{ color: '#10b981' }}>{data.matches}</span>
          </div>
          <div className="recharts-tooltip-row">
            <span>Deviations / Errors:</span>
            <span style={{ color: '#ef4444' }}>{data.errors}</span>
          </div>
        </div>
      );
    }
    return null;
  };

  // Custom Donut Tooltip
  const renderDonutTooltip = (props: any) => {
    const { active, payload } = props;
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const pct = totalVerdicts > 0 ? ((data.value / totalVerdicts) * 100).toFixed(1) : '0';
      return (
        <div className="recharts-custom-tooltip">
          <div className="recharts-tooltip-title" style={{ color: data.color }}>
            {data.label}
          </div>
          <div className="recharts-tooltip-row">
            <span>Count:</span>
            <span style={{ fontWeight: 700 }}>{data.value}</span>
          </div>
          <div className="recharts-tooltip-row">
            <span>Share:</span>
            <span>{pct}%</span>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="analytics-page-container">
      {/* Header */}
      <header className="analytics-header">
        <div className="analytics-header-left">
          <h1>
            <BarChart3 size={28} color="#3b82f6" />
            Safety Analytics &amp; Read-Back Telemetry
          </h1>
          <p>
            Real metrics computed directly from Supabase: transmission counts, clearance verification rates, and historical error trends.
          </p>
        </div>
        <div className="analytics-header-right">
          <button
            type="button"
            className="analytics-refresh-btn"
            onClick={loadData}
            disabled={loading}
            aria-label="Refresh safety analytics"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>{loading ? 'Computing…' : 'Refresh Metrics'}</span>
          </button>
        </div>
      </header>

      {/* Error state */}
      {error && (
        <div className="chart-empty-state" style={{ borderColor: '#ef4444' }}>
          <AlertOctagon size={32} color="#ef4444" />
          <div className="chart-empty-title">Failed to load Supabase analytics</div>
          <div>{error}</div>
        </div>
      )}

      {/* Honest Empty State if zero transmissions */}
      {!loading && !error && totalTransmissions === 0 && (
        <div className="chart-empty-state">
          <Radio size={36} color="var(--text-tertiary)" />
          <div className="chart-empty-title">No Aeronautical Transmissions Recorded</div>
          <div>
            Run an ATC/Pilot simulation in Dashboard or initiate a Comm Room to produce live verification records.
          </div>
        </div>
      )}

      {/* Real Computed KPI Metrics Grid */}
      <div className="analytics-kpi-grid">
        {/* Total Transmissions */}
        <div className="analytics-kpi-card">
          <div className="analytics-kpi-top">
            <span className="analytics-kpi-label">Total Transmissions</span>
            <div className="analytics-kpi-icon primary">
              <Radio size={16} />
            </div>
          </div>
          <div className="analytics-kpi-value">{totalTransmissions}</div>
          <div className="analytics-kpi-subtext">Recorded radio calls in Supabase</div>
        </div>

        {/* Non-Match Error Rate */}
        <div className="analytics-kpi-card">
          <div className="analytics-kpi-top">
            <span className="analytics-kpi-label">Deviation / Error Rate</span>
            <div className="analytics-kpi-icon danger">
              <TrendingDown size={16} />
            </div>
          </div>
          <div className="analytics-kpi-value" style={{ color: errorRate > 50 ? '#ef4444' : '#f59e0b' }}>
            {errorRate}%
          </div>
          <div className="analytics-kpi-subtext">% of verdicts that are not MATCH</div>
        </div>

        {/* Exact Match Count */}
        <div className="analytics-kpi-card">
          <div className="analytics-kpi-top">
            <span className="analytics-kpi-label">Exact Matches</span>
            <div className="analytics-kpi-icon success">
              <CheckCircle2 size={16} />
            </div>
          </div>
          <div className="analytics-kpi-value" style={{ color: '#10b981' }}>
            {matchCount}
          </div>
          <div className="analytics-kpi-subtext">100% verified read-backs</div>
        </div>

        {/* Critical Mismatches */}
        <div className="analytics-kpi-card">
          <div className="analytics-kpi-top">
            <span className="analytics-kpi-label">Critical Mismatches</span>
            <div className="analytics-kpi-icon danger">
              <AlertTriangle size={16} />
            </div>
          </div>
          <div className="analytics-kpi-value" style={{ color: '#ef4444' }}>
            {mismatchCount}
          </div>
          <div className="analytics-kpi-subtext">Runway, altitude, or heading swaps</div>
        </div>

        {/* Partial / Unverified Breakdown */}
        <div className="analytics-kpi-card">
          <div className="analytics-kpi-top">
            <span className="analytics-kpi-label">Partial / Unverified</span>
            <div className="analytics-kpi-icon warning">
              <HelpCircle size={16} />
            </div>
          </div>
          <div className="analytics-kpi-value">
            {partialCount + unverifiedCount}
          </div>
          <div className="analytics-kpi-subtext">
            {partialCount} partial · {unverifiedCount} unverified
          </div>
        </div>
      </div>

      {/* Visual Analytics Charts Grid */}
      <div className="analytics-charts-grid">
        {/* Error Trend Line Chart */}
        <div className="analytics-chart-panel">
          <div className="analytics-chart-panel-header">
            <div>
              <h2 className="analytics-chart-title">
                <TrendingDown size={18} color="#ef4444" />
                Error Rate Trend Across Sessions
              </h2>
              <div className="analytics-chart-subtitle">
                Historical non-match % over chronological communication session timestamps
              </div>
            </div>
          </div>

          <div className="analytics-chart-wrapper">
            {trendData.length >= 2 ? (
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={trendData} margin={{ top: 10, right: 20, left: -10, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.08)" />
                  <XAxis
                    dataKey="formattedDate"
                    stroke="#94a3b8"
                    fontSize={11}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={[0, 100]}
                    stroke="#94a3b8"
                    fontSize={11}
                    tickFormatter={(val) => `${val}%`}
                  />
                  <Tooltip content={renderTrendTooltip} />
                  <Line
                    type="monotone"
                    dataKey="errorRate"
                    name="Error Rate (%)"
                    stroke="#ef4444"
                    strokeWidth={2.5}
                    dot={{ fill: '#ef4444', r: 4 }}
                    activeDot={{ r: 6, fill: '#f87171' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="chart-empty-state">
                <Calendar size={28} color="var(--text-tertiary)" />
                <div className="chart-empty-title">Insufficient Historical Session Data</div>
                <div>
                  {trendData.length === 1
                    ? 'Only 1 session timestamp is stored. Run another comm session to generate multi-point trend lines.'
                    : 'No session timestamps are currently available in Supabase.'}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Outcome Distribution Donut Chart */}
        <div className="analytics-chart-panel">
          <div className="analytics-chart-panel-header">
            <div>
              <h2 className="analytics-chart-title">
                <PieIcon size={18} color="#10b981" />
                Outcome Distribution
              </h2>
              <div className="analytics-chart-subtitle">
                Proportion of verdicts by validation outcome category
              </div>
            </div>
          </div>

          <div className="analytics-chart-wrapper" style={{ height: 210 }}>
            {outcomeDistribution.length > 0 ? (
              <ResponsiveContainer width="100%" height={210}>
                <PieChart>
                  <Tooltip content={renderDonutTooltip} />
                  <Pie
                    data={outcomeDistribution}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={3}
                  >
                    {outcomeDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="chart-empty-state">
                <HelpCircle size={28} color="var(--text-tertiary)" />
                <div className="chart-empty-title">No Outcome Telemetry</div>
                <div>Zero verdict records available for distribution plotting.</div>
              </div>
            )}
          </div>

          {/* Donut Legend */}
          <div className="donut-legend-list">
            {(analytics?.outcomeDistribution ?? []).map((item) => {
              const pct = totalVerdicts > 0 ? ((item.value / totalVerdicts) * 100).toFixed(1) : '0';
              return (
                <div key={item.name} className="donut-legend-item">
                  <div className="donut-legend-left">
                    <span className="donut-legend-dot" style={{ background: item.color }} />
                    <span style={{ color: 'var(--text-primary)' }}>{item.label}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{pct}%</span>
                    <span className="donut-legend-count">{item.value}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Chronological Session Breakdown Table */}
      {trendData.length > 0 && (
        <div className="analytics-table-panel">
          <div className="analytics-chart-panel-header">
            <div>
              <h2 className="analytics-chart-title">
                <ShieldCheck size={18} color="#60a5fa" />
                Session Telemetry Log
              </h2>
              <div className="analytics-chart-subtitle">
                Computed verification metrics broken down by individual Aeronautical session
              </div>
            </div>
          </div>

          <div className="analytics-table-container">
            <table className="analytics-table">
              <thead>
                <tr>
                  <th>Session Timestamp</th>
                  <th>Scenario / Room</th>
                  <th>Total Clearances</th>
                  <th>Exact Matches</th>
                  <th>Deviations / Errors</th>
                  <th>Error Rate</th>
                </tr>
              </thead>
              <tbody>
                {trendData.slice().reverse().map((session) => (
                  <tr key={session.sessionId}>
                    <td style={{ fontFamily: 'ui-monospace, monospace' }}>
                      {session.formattedDate}
                    </td>
                    <td style={{ fontWeight: 600 }}>{session.sessionName}</td>
                    <td>{session.total}</td>
                    <td style={{ color: '#10b981', fontWeight: 600 }}>{session.matches}</td>
                    <td style={{ color: session.errors > 0 ? '#ef4444' : '#10b981', fontWeight: 600 }}>
                      {session.errors}
                    </td>
                    <td>
                      <span
                        style={{
                          padding: '3px 8px',
                          borderRadius: 4,
                          fontSize: 12,
                          fontWeight: 700,
                          background: session.errorRate > 50 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                          color: session.errorRate > 50 ? '#ef4444' : '#10b981',
                        }}
                      >
                        {session.errorRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
