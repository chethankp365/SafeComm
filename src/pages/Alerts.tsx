import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  Bell,
  AlertCircle,
  FileCheck2,
} from 'lucide-react';
import { fetchSafetyAlerts, acknowledgeAlert, type SafetyAlert } from '../lib/alertsAnalyticsService';
import './Alerts.css';

type SeverityFilter = 'ALL' | 'HIGH' | 'MEDIUM' | 'LOW';

export const Alerts: React.FC = () => {
  const [alerts, setAlerts] = useState<SafetyAlert[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<SeverityFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [acknowledgingIds, setAcknowledgingIds] = useState<Set<string>>(new Set());

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { alerts: data, error: fetchErr } = await fetchSafetyAlerts('ALL');
    if (fetchErr) {
      setError(fetchErr);
    } else {
      setAlerts(data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAlerts();

    // Listen to alert updates across windows/tabs
    const handleUpdate = () => {
      void fetchSafetyAlerts('ALL').then(({ alerts: data }) => {
        if (data.length > 0) setAlerts(data);
      });
    };
    window.addEventListener('safecomm-alerts-updated', handleUpdate);
    return () => window.removeEventListener('safecomm-alerts-updated', handleUpdate);
  }, [loadAlerts]);

  // Handle single alert acknowledgement
  const handleAcknowledge = async (alertId: string) => {
    if (acknowledgingIds.has(alertId)) return;

    // Optimistic UI update
    setAcknowledgingIds((prev) => new Set(prev).add(alertId));
    setAlerts((prev) =>
      prev.map((a) => (a.alert_id === alertId ? { ...a, acknowledged: true } : a))
    );

    const { success, error: ackErr } = await acknowledgeAlert(alertId);
    if (!success) {
      console.error('Failed to acknowledge alert in Supabase:', ackErr);
      // Revert if error
      setAlerts((prev) =>
        prev.map((a) => (a.alert_id === alertId ? { ...a, acknowledged: false } : a))
      );
    }
    setAcknowledgingIds((prev) => {
      const next = new Set(prev);
      next.delete(alertId);
      return next;
    });
  };

  // Filtered alerts
  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      // 1. Severity tab filter
      if (activeFilter === 'HIGH' && alert.severity_tier !== 'HIGH') return false;
      if (activeFilter === 'MEDIUM' && alert.severity_tier !== 'MEDIUM') return false;
      if (activeFilter === 'LOW' && alert.severity_tier !== 'LOW') return false;

      // 2. Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesCallsign = alert.callsign.toLowerCase().includes(q);
        const matchesExplanation = alert.explanation.toLowerCase().includes(q);
        const matchesReadback = alert.readback_text?.toLowerCase().includes(q) ?? false;
        const matchesController = alert.controller_text?.toLowerCase().includes(q) ?? false;
        if (!matchesCallsign && !matchesExplanation && !matchesReadback && !matchesController) {
          return false;
        }
      }

      return true;
    });
  }, [alerts, activeFilter, searchQuery]);

  // Summary counts
  const totalCount = alerts.length;
  const highCount = alerts.filter((a) => a.severity_tier === 'HIGH').length;
  const mediumCount = alerts.filter((a) => a.severity_tier === 'MEDIUM').length;
  const lowCount = alerts.filter((a) => a.severity_tier === 'LOW').length;
  const unreadCount = alerts.filter((a) => !a.acknowledged && (a.severity_tier === 'HIGH' || a.severity_tier === 'MEDIUM')).length;
  const acknowledgedCount = alerts.filter((a) => a.acknowledged).length;

  return (
    <div className="alerts-page-container">
      {/* Header */}
      <header className="alerts-header">
        <div className="alerts-header-left">
          <h1>
            <ShieldAlert size={28} color="#ef4444" />
            Safety Alerts &amp; Discrepancies
          </h1>
          <p>
            Real-time clearance deviations, read-back mismatches, and safety alerts persisted in Supabase.
          </p>
        </div>
        <div className="alerts-header-right">
          <button
            type="button"
            className="alerts-refresh-btn"
            onClick={loadAlerts}
            disabled={loading}
            aria-label="Refresh safety alerts"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>{loading ? 'Refreshing…' : 'Refresh Alerts'}</span>
          </button>
        </div>
      </header>

      {/* KPI Stats Bar */}
      <div className="alerts-stats-bar">
        <div className="alerts-stat-card">
          <div className="alerts-stat-icon critical">
            <AlertTriangle size={22} />
          </div>
          <div className="alerts-stat-info">
            <span className="alerts-stat-label">Critical / High</span>
            <span className="alerts-stat-value">{highCount}</span>
          </div>
        </div>

        <div className="alerts-stat-card">
          <div className="alerts-stat-icon warning">
            <AlertCircle size={22} />
          </div>
          <div className="alerts-stat-info">
            <span className="alerts-stat-label">Warning / Medium</span>
            <span className="alerts-stat-value">{mediumCount}</span>
          </div>
        </div>

        <div className="alerts-stat-card">
          <div className="alerts-stat-icon unread">
            <Bell size={22} />
          </div>
          <div className="alerts-stat-info">
            <span className="alerts-stat-label">Unread (High/Med)</span>
            <span className="alerts-stat-value">{unreadCount}</span>
          </div>
        </div>

        <div className="alerts-stat-card">
          <div className="alerts-stat-icon ack">
            <FileCheck2 size={22} />
          </div>
          <div className="alerts-stat-info">
            <span className="alerts-stat-label">Acknowledged</span>
            <span className="alerts-stat-value">{acknowledgedCount}</span>
          </div>
        </div>
      </div>

      {/* Toolbar & Filter Tabs */}
      <div className="alerts-toolbar">
        <div className="alerts-tabs" role="tablist" aria-label="Filter alerts by severity">
          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === 'ALL'}
            className={`alerts-tab-btn ${activeFilter === 'ALL' ? 'is-active' : ''}`}
            onClick={() => setActiveFilter('ALL')}
          >
            <span>All Alerts</span>
            <span className="alerts-tab-pill">{totalCount}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === 'HIGH'}
            className={`alerts-tab-btn ${activeFilter === 'HIGH' ? 'is-active' : ''}`}
            onClick={() => setActiveFilter('HIGH')}
          >
            <span>High Severity</span>
            <span className="alerts-tab-pill" style={{ color: '#ef4444' }}>{highCount}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === 'MEDIUM'}
            className={`alerts-tab-btn ${activeFilter === 'MEDIUM' ? 'is-active' : ''}`}
            onClick={() => setActiveFilter('MEDIUM')}
          >
            <span>Medium Severity</span>
            <span className="alerts-tab-pill" style={{ color: '#f59e0b' }}>{mediumCount}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === 'LOW'}
            className={`alerts-tab-btn ${activeFilter === 'LOW' ? 'is-active' : ''}`}
            onClick={() => setActiveFilter('LOW')}
          >
            <span>Low Severity</span>
            <span className="alerts-tab-pill">{lowCount}</span>
          </button>
        </div>

        <div className="alerts-search-box">
          <Search size={15} color="var(--text-tertiary)" />
          <input
            type="text"
            className="alerts-search-input"
            placeholder="Search by callsign or description…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Filter alerts by keyword"
          />
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="alert-empty-state" style={{ borderColor: '#ef4444' }}>
          <AlertTriangle size={32} color="#ef4444" />
          <div className="alert-empty-title">Error Loading Alerts</div>
          <div>{error}</div>
        </div>
      )}

      {/* Loading state */}
      {loading && alerts.length === 0 && (
        <div className="alert-empty-state">
          <RefreshCw size={28} className="animate-spin" color="var(--text-tertiary)" />
          <div className="alert-empty-title">Retrieving Live Safety Alerts…</div>
          <div>Querying Supabase alerts and verdict telemetry.</div>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && filteredAlerts.length === 0 && (
        <div className="alert-empty-state">
          <CheckCircle2 size={36} color="#10b981" />
          <div className="alert-empty-title">No Safety Alerts Found</div>
          <div>
            {searchQuery
              ? `No alerts matching search term "${searchQuery}".`
              : activeFilter !== 'ALL'
              ? `No safety deviations recorded with severity ${activeFilter}.`
              : 'All transmissions have been verified without safety alerts.'}
          </div>
        </div>
      )}

      {/* Alert Cards */}
      <div className="alerts-list">
        {filteredAlerts.map((alert) => {
          const isHigh = alert.severity_tier === 'HIGH';
          const isMedium = alert.severity_tier === 'MEDIUM';
          const isAcking = acknowledgingIds.has(alert.alert_id);

          return (
            <article
              key={alert.alert_id}
              className={`alert-card ${
                isHigh ? 'severity-high' : isMedium ? 'severity-medium' : 'severity-low'
              }`}
            >
              {/* Card Header */}
              <div className="alert-card-header">
                <div className="alert-card-badges">
                  {/* Severity Badge */}
                  <span
                    className={`badge-severity ${
                      isHigh ? 'high' : isMedium ? 'medium' : 'low'
                    }`}
                  >
                    <AlertTriangle size={12} />
                    {alert.severity_tier} SEVERITY
                  </span>

                  {/* Aircraft Callsign */}
                  <span className="badge-callsign" title="Aircraft Callsign">
                    {alert.callsign}
                  </span>

                  {/* Outcome Pill */}
                  <span
                    className={`badge-outcome ${
                      alert.outcome === 'MISMATCH'
                        ? 'mismatch'
                        : alert.outcome === 'PARTIAL'
                        ? 'partial'
                        : 'match'
                    }`}
                  >
                    {alert.outcome}
                  </span>
                </div>

                <div className="alert-card-actions">
                  {/* Timestamp */}
                  <div className="alert-timestamp" title={alert.created_at}>
                    <Clock size={13} />
                    <span>{new Date(alert.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} UTC</span>
                  </div>

                  {/* Acknowledge Button */}
                  <button
                    type="button"
                    className={`alert-ack-btn ${alert.acknowledged ? 'is-acknowledged' : ''}`}
                    onClick={() => handleAcknowledge(alert.alert_id)}
                    disabled={alert.acknowledged || isAcking}
                    aria-label={alert.acknowledged ? 'Alert acknowledged' : 'Acknowledge safety alert'}
                  >
                    <CheckCircle2 size={13} />
                    <span>
                      {alert.acknowledged
                        ? 'Acknowledged'
                        : isAcking
                        ? 'Updating…'
                        : 'Acknowledge'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Card Body */}
              <div className="alert-card-body">
                <p className="alert-description">{alert.explanation}</p>

                {/* Telemetry Context Box */}
                {(alert.controller_text || alert.readback_text) && (
                  <div className="alert-telemetry-box">
                    {alert.controller_text && (
                      <div className="telemetry-item">
                        <span className="telemetry-label">Assigned ATC Clearance</span>
                        <span className="telemetry-val">“{alert.controller_text}”</span>
                      </div>
                    )}
                    {alert.readback_text && (
                      <div className="telemetry-item">
                        <span className="telemetry-label">Pilot Read-Back</span>
                        <span className="telemetry-val">“{alert.readback_text}”</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Card Footer */}
              <div className="alert-card-footer">
                <span>Scenario: {alert.scenario_name}</span>
                <span>Session ID: {alert.session_id.substring(0, 8)}…</span>
                <span>Date: {new Date(alert.created_at).toLocaleDateString()}</span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
};
