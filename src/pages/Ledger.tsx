import React, { useState, useEffect, useMemo } from 'react';
import {
  ScrollText,
  Search,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  HelpCircle,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  Plane,
} from 'lucide-react';
import {
  fetchLedgerRecords,
  exportLedgerToCsv,
  type LedgerRecord,
} from '../lib/ledgerService';
import './Ledger.css';

export const Ledger: React.FC = () => {
  const [records, setRecords] = useState<LedgerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED'>('ALL');
  const [severityFilter, setSeverityFilter] = useState<'ALL' | 'CRITICAL' | 'WARNING' | 'OK'>('ALL');
  const [sessionFilter, setSessionFilter] = useState<string>('ALL');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Detail Modal
  const [selectedRecord, setSelectedRecord] = useState<LedgerRecord | null>(null);

  // Fetch real Supabase data on mount
  const loadData = async () => {
    setLoading(true);
    setError(null);
    const result = await fetchLedgerRecords({ limit: 1000 });
    if (result.error) {
      setError(result.error);
    } else {
      setRecords(result.records);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  // Distinct sessions for filter dropdown
  const sessionsList = useMemo(() => {
    const map = new Map<string, string>();
    records.forEach((r) => {
      if (r.session_id && !map.has(r.session_id)) {
        map.set(r.session_id, r.scenario_name);
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [records]);

  // Filtered dataset
  const filteredRecords = useMemo(() => {
    return records.filter((r) => {
      // Status filter
      if (statusFilter !== 'ALL' && r.outcome !== statusFilter) return false;

      // Severity filter
      if (severityFilter !== 'ALL' && r.severity !== severityFilter) return false;

      // Session filter
      if (sessionFilter !== 'ALL' && r.session_id !== sessionFilter) return false;

      // Text search
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const callsignMatch = r.callsign.toLowerCase().includes(query);
        const readbackMatch = (r.readback_text || '').toLowerCase().includes(query);
        const controllerMatch = (r.controller_text || '').toLowerCase().includes(query);
        const explanationMatch = (r.explanation || '').toLowerCase().includes(query);
        const scenarioMatch = (r.scenario_name || '').toLowerCase().includes(query);

        if (!callsignMatch && !readbackMatch && !controllerMatch && !explanationMatch && !scenarioMatch) {
          return false;
        }
      }

      return true;
    });
  }, [records, statusFilter, severityFilter, sessionFilter, searchQuery]);

  // Pagination slice
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const paginatedRecords = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredRecords.slice(start, start + pageSize);
  }, [filteredRecords, currentPage, pageSize]);

  // Adjust page if filter shrinks total
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(1);
    }
  }, [totalPages, currentPage]);

  // Statistics
  const stats = useMemo(() => {
    const total = records.length;
    const matches = records.filter((r) => r.outcome === 'MATCH').length;
    const mismatches = records.filter((r) => r.outcome === 'MISMATCH').length;
    const unverified = records.filter((r) => r.outcome === 'UNVERIFIED').length;
    const partials = records.filter((r) => r.outcome === 'PARTIAL').length;
    const matchRate = total > 0 ? ((matches / (matches + mismatches || 1)) * 100).toFixed(1) : '100.0';

    return { total, matches, mismatches, unverified, partials, matchRate };
  }, [records]);

  // Handle Export CSV
  const handleExportCsv = () => {
    exportLedgerToCsv(filteredRecords, `safecomm-ledger-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const formatUtcTimestamp = (isoString: string): string => {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(
        d.getUTCSeconds()
      ).padStart(2, '0')} UTC`;
    } catch {
      return isoString;
    }
  };

  const renderStatusPill = (outcome: LedgerRecord['outcome'], severity: LedgerRecord['severity']) => {
    switch (outcome) {
      case 'MATCH':
        return (
          <span className="ledger-status-pill ledger-status-match" title="Verified Readback Match">
            <CheckCircle2 size={13} strokeWidth={2.5} />
            MATCHED
          </span>
        );
      case 'MISMATCH':
        return (
          <span
            className="ledger-status-pill ledger-status-mismatch"
            title={severity === 'CRITICAL' ? 'Critical Safety Deviation' : 'Safety Discrepancy'}
          >
            {severity === 'CRITICAL' ? <AlertOctagon size={13} strokeWidth={2.5} /> : <AlertTriangle size={13} strokeWidth={2.5} />}
            MISMATCH
          </span>
        );
      case 'PARTIAL':
        return (
          <span className="ledger-status-pill ledger-status-partial" title="Partial Parameter Omission">
            <AlertTriangle size={13} strokeWidth={2.5} />
            PARTIAL
          </span>
        );
      case 'UNVERIFIED':
      default:
        return (
          <span className="ledger-status-pill ledger-status-unverified" title="Provisional or Unmatched">
            <HelpCircle size={13} strokeWidth={2.5} />
            UNVERIFIED
          </span>
        );
    }
  };

  return (
    <div className="ledger-container">
      {/* Top Header */}
      <div className="ledger-header">
        <div className="ledger-title-group">
          <h1>
            <ScrollText size={28} strokeWidth={2.2} />
            Instruction & Read-Back Ledger
            <span className="ledger-badge">FAA/ICAO AUDIT TRAIL</span>
          </h1>
          <p className="ledger-subtitle">
            Immutable, cryptographically verifiable ledger of ATC instructions, pilot read-backs, and Safety Sentinel verdicts
            retrieved live from Supabase.
          </p>
        </div>

        <div className="ledger-actions">
          <button
            type="button"
            className="ledger-btn"
            onClick={loadData}
            disabled={loading}
            title="Refresh rows from Supabase"
            id="ledger-refresh-btn"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Fetching...' : 'Refresh'}
          </button>

          <button
            type="button"
            className="ledger-btn ledger-btn-primary"
            onClick={handleExportCsv}
            disabled={filteredRecords.length === 0}
            title="Export current table to CSV"
            id="ledger-export-csv-btn"
          >
            <Download size={14} />
            Export CSV ({filteredRecords.length})
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="ledger-stats-bar">
        <div className="ledger-stat-card">
          <span className="ledger-stat-label">Total Transmissions</span>
          <span className="ledger-stat-value">{stats.total}</span>
          <span className="ledger-stat-meta">Across {sessionsList.length || 1} logged sessions</span>
        </div>

        <div className="ledger-stat-card">
          <span className="ledger-stat-label">Verified Matches</span>
          <span className="ledger-stat-value" style={{ color: 'var(--accent-match)' }}>
            {stats.matches}
          </span>
          <span className="ledger-stat-meta">{stats.matchRate}% compliant readbacks</span>
        </div>

        <div className="ledger-stat-card">
          <span className="ledger-stat-label">Safety Deviations</span>
          <span className="ledger-stat-value" style={{ color: 'var(--accent-critical)' }}>
            {stats.mismatches}
          </span>
          <span className="ledger-stat-meta">Flagged by Safety Sentinel</span>
        </div>

        <div className="ledger-stat-card">
          <span className="ledger-stat-label">Unverified / Partial</span>
          <span className="ledger-stat-value">{stats.unverified + stats.partials}</span>
          <span className="ledger-stat-meta">{stats.partials} partials · {stats.unverified} unverified</span>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="ledger-toolbar">
        <div className="ledger-search-box">
          <Search size={16} color="var(--text-tertiary)" />
          <input
            type="text"
            placeholder="Search by callsign, ATC instruction, readback, or reason..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            id="ledger-search-input"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              <X size={14} color="var(--text-tertiary)" />
            </button>
          )}
        </div>

        <div className="ledger-filters-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Filter size={14} color="var(--text-muted)" />
            <select
              className="ledger-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              id="ledger-status-filter"
            >
              <option value="ALL">All Statuses ({records.length})</option>
              <option value="MATCH">Matched Only</option>
              <option value="MISMATCH">Mismatches Only</option>
              <option value="PARTIAL">Partials Only</option>
              <option value="UNVERIFIED">Unverified Only</option>
            </select>
          </div>

          <select
            className="ledger-select"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as any)}
            id="ledger-severity-filter"
          >
            <option value="ALL">All Severities</option>
            <option value="CRITICAL">Critical Severity</option>
            <option value="WARNING">Warning Severity</option>
            <option value="OK">OK / Nominal</option>
          </select>

          {sessionsList.length > 1 && (
            <select
              className="ledger-select"
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
              id="ledger-session-filter"
            >
              <option value="ALL">All Sessions ({sessionsList.length})</option>
              {sessionsList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name.length > 36 ? `${s.name.slice(0, 36)}...` : s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div
          style={{
            background: 'var(--accent-critical-bg)',
            border: '1px solid var(--accent-critical-border)',
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            color: 'var(--accent-critical)',
            marginBottom: '16px',
            fontSize: '13px',
          }}
        >
          <strong>Error querying Supabase:</strong> {error}
        </div>
      )}

      {/* Glass Table Card */}
      <div className="ledger-table-card">
        <div className="ledger-table-wrapper">
          <table className="ledger-table" id="ledger-table">
            <thead>
              <tr>
                <th style={{ width: '110px' }}>Time (UTC)</th>
                <th style={{ width: '130px' }}>Callsign</th>
                <th>Preceding ATC Instruction</th>
                <th>Pilot Read-Back</th>
                <th style={{ width: '140px' }}>Read-Back Status</th>
                <th style={{ width: '80px', textAlign: 'center' }}>Details</th>
              </tr>
            </thead>
            <tbody>
              {loading && records.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '48px 16px' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                      <RefreshCw size={16} className="animate-spin" />
                      Loading live transmission rows from Supabase...
                    </div>
                  </td>
                </tr>
              ) : paginatedRecords.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="ledger-empty-state">
                      <ScrollText size={32} strokeWidth={1.5} />
                      <div style={{ fontWeight: 600 }}>No transmission records match your filter criteria</div>
                      <div style={{ fontSize: '13px' }}>Try broadening your search query or clearing the status filter.</div>
                      <button
                        type="button"
                        className="ledger-btn"
                        style={{ marginTop: '8px' }}
                        onClick={() => {
                          setSearchQuery('');
                          setStatusFilter('ALL');
                          setSeverityFilter('ALL');
                          setSessionFilter('ALL');
                        }}
                      >
                        Reset All Filters
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedRecords.map((record) => (
                  <tr
                    key={record.verdict_id}
                    className={`ledger-row ${selectedRecord?.verdict_id === record.verdict_id ? 'is-selected' : ''}`}
                    onClick={() => setSelectedRecord(record)}
                    style={{ cursor: 'pointer' }}
                  >
                    {/* Time */}
                    <td className="ledger-cell-time">
                      {formatUtcTimestamp(record.created_at)}
                    </td>

                    {/* Callsign */}
                    <td className="ledger-cell-callsign">
                      <span className="ledger-callsign-pill">
                        <Plane size={11} color="var(--text-tertiary)" />
                        {record.callsign || 'UNKNOWN'}
                      </span>
                    </td>

                    {/* ATC Instruction */}
                    <td className="ledger-cell-instruction">
                      {record.controller_text ? (
                        <div className="ledger-text-highlight">{record.controller_text}</div>
                      ) : record.instruction_type && record.instruction_value !== 'UNPARSED_TRANSMISSION' ? (
                        <div>
                          <span className="ledger-instruction-tag">{record.instruction_type}</span>
                          <div className="ledger-text-highlight">
                            {record.direction ? `${record.direction.toUpperCase()} ` : ''}
                            {record.instruction_value}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                          Standard Approach / Frequency Broadcast
                        </span>
                      )}
                    </td>

                    {/* Pilot Read-Back */}
                    <td className="ledger-cell-readback">
                      <div className="ledger-text-highlight">
                        {record.readback_text || '—'}
                      </div>
                      {record.explanation && record.outcome !== 'MATCH' && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {record.explanation}
                        </div>
                      )}
                    </td>

                    {/* Read-Back Status */}
                    <td>
                      {renderStatusPill(record.outcome, record.severity)}
                    </td>

                    {/* Inspect Button */}
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        className="ledger-btn"
                        style={{ padding: '4px 8px', fontSize: '11px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedRecord(record);
                        }}
                        title="View complete transmission and verification parameters"
                      >
                        <ExternalLink size={12} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        <div className="ledger-pagination">
          <div>
            Showing <strong>{filteredRecords.length > 0 ? (currentPage - 1) * pageSize + 1 : 0}</strong> to{' '}
            <strong>{Math.min(currentPage * pageSize, filteredRecords.length)}</strong> of{' '}
            <strong>{filteredRecords.length}</strong> records (total {records.length} stored)
          </div>

          <div className="ledger-pagination-controls">
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Rows per page:{' '}
              <select
                className="ledger-select"
                style={{ padding: '3px 8px', fontSize: '11px' }}
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
              >
                <option value={10}>10</option>
                <option value={15}>15</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>

            <button
              type="button"
              className="ledger-page-btn"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => p - 1)}
              aria-label="Previous Page"
            >
              <ChevronLeft size={14} />
            </button>

            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
              Page {currentPage} of {totalPages}
            </span>

            <button
              type="button"
              className="ledger-page-btn"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => p + 1)}
              aria-label="Next Page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Detailed Inspection Modal */}
      {selectedRecord && (
        <div className="ledger-modal-backdrop" onClick={() => setSelectedRecord(null)}>
          <div className="ledger-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="ledger-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Plane size={18} />
                <span style={{ fontWeight: 700, fontSize: '16px', fontFamily: 'var(--font-mono)' }}>
                  {selectedRecord.callsign}
                </span>
                {renderStatusPill(selectedRecord.outcome, selectedRecord.severity)}
              </div>
              <button
                type="button"
                onClick={() => setSelectedRecord(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
                aria-label="Close details modal"
              >
                <X size={18} color="var(--text-secondary)" />
              </button>
            </div>

            <div className="ledger-modal-body">
              <div className="ledger-detail-section">
                <span className="ledger-detail-label">Preceding Controller Clearance</span>
                <div className="ledger-detail-box">
                  {selectedRecord.controller_text || 'No preceding ATC transmission recorded.'}
                </div>
              </div>

              <div className="ledger-detail-section">
                <span className="ledger-detail-label">Pilot Read-Back Utterance</span>
                <div className="ledger-detail-box" style={{ fontWeight: 500 }}>
                  {selectedRecord.readback_text || '—'}
                </div>
              </div>

              <div className="ledger-detail-section">
                <span className="ledger-detail-label">Safety Sentinel Verdict & Discrepancy Analysis</span>
                <div
                  className="ledger-detail-box"
                  style={{
                    borderLeft: `4px solid ${
                      selectedRecord.outcome === 'MATCH'
                        ? 'var(--accent-match)'
                        : selectedRecord.outcome === 'MISMATCH'
                        ? 'var(--accent-critical)'
                        : 'var(--accent-warning)'
                    }`,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                    {selectedRecord.outcome} · SEVERITY: {selectedRecord.severity}
                  </div>
                  <div>{selectedRecord.explanation}</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                <div className="ledger-detail-section">
                  <span className="ledger-detail-label">Instruction Type</span>
                  <div className="ledger-detail-box" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                    {selectedRecord.instruction_type}
                    {selectedRecord.direction ? ` (${selectedRecord.direction})` : ''}
                  </div>
                </div>

                <div className="ledger-detail-section">
                  <span className="ledger-detail-label">Assigned Value</span>
                  <div className="ledger-detail-box" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                    {selectedRecord.instruction_value || 'None'}
                  </div>
                </div>
              </div>

              <div className="ledger-detail-section">
                <span className="ledger-detail-label">Session Name & Metadata</span>
                <div className="ledger-detail-box" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  <div><strong>Session:</strong> {selectedRecord.scenario_name}</div>
                  <div><strong>Recorded:</strong> {new Date(selectedRecord.created_at).toUTCString()}</div>
                  <div style={{ marginTop: '4px', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                    Verdict UUID: {selectedRecord.verdict_id}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
