import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Radio,
  Plane,
  X,
  Copy,
  Check,
  Play,
  LogOut,
  AlertCircle,
  TowerControl,
  Loader2,
} from 'lucide-react';
import {
  type CommRole,
  type CommRoomState,
  createCommRoom,
  joinCommRoom,
  startCommRoom,
  leaveCommRoom,
  subscribeToCommRoom,
} from '../../lib/commRooms';
import { playRadioTone } from '../../lib/speechAudio';
import './CommRoomModal.css';

interface CommRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialRole?: CommRole;
}

export const CommRoomModal: React.FC<CommRoomModalProps> = ({
  isOpen,
  onClose,
}) => {
  const navigate = useNavigate();

  // Navigation / view mode
  const [viewMode, setViewMode] = useState<'CHOICE' | 'WAITING_ROOM'>('CHOICE');

  // Input states
  const [atcCallsign, setAtcCallsign] = useState<string>('KSFO Tower');
  const [pilotCallsign, setPilotCallsign] = useState<string>('Speedbird 214');
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');

  // Execution & sync state
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [roomState, setRoomState] = useState<CommRoomState | null>(null);

  // Reset or initialize when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setErrorMessage(null);
      setIsSubmitting(false);
      setCopiedCode(false);
    }
  }, [isOpen]);

  // Setup Realtime & Broadcast Subscription whenever in WAITING_ROOM mode
  useEffect(() => {
    if (viewMode !== 'WAITING_ROOM' || !roomState?.room?.id) {
      return;
    }

    const currentRole = roomState.currentRole || 'atc';
    const unsubscribe = subscribeToCommRoom(roomState.room.id, currentRole, (updated) => {
      // Audio chime if pilot just joined
      if (
        roomState.room.status === 'waiting' &&
        updated.room.status === 'ready' &&
        currentRole === 'atc'
      ) {
        try {
          playRadioTone('alert_chime');
        } catch {
          // ignore
        }
      }

      // Audio click & automatic transition to dedicated Comm Session for both participants
      if (updated.room.status === 'active') {
        try {
          playRadioTone('mic_click');
        } catch {
          // ignore
        }
        onClose();
        navigate(`/comm/${updated.room.id}`);
        return;
      }

      setRoomState(updated);
    });

    return () => {
      unsubscribe();
    };
  }, [viewMode, roomState?.room?.id, roomState?.currentRole, onClose, navigate]);

  if (!isOpen) return null;

  // 1. Handle "Create Comm" (ATC Officer)
  const handleCreateComm = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);

    const res = await createCommRoom({
      callsign: atcCallsign,
      airport: 'KSFO',
      frequency: '120.500 MHz',
    });

    setIsSubmitting(false);

    if (res.error || !res.data) {
      setErrorMessage(res.error || 'Failed to establish ATC communication channel.');
      return;
    }

    try {
      playRadioTone('mic_click');
    } catch {
      // ignore
    }

    setRoomState(res.data);
    setViewMode('WAITING_ROOM');
  };

  // 2. Handle "Join Comm" (Pilot)
  const handleJoinComm = async () => {
    const cleanCode = joinCodeInput.trim().toUpperCase();
    if (!cleanCode) {
      setErrorMessage('Please enter an active communication code (e.g. SFC-742).');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    const res = await joinCommRoom(cleanCode, pilotCallsign);
    setIsSubmitting(false);

    if (res.error || !res.data) {
      setErrorMessage(res.error || 'Unable to join communication room.');
      return;
    }

    try {
      playRadioTone('mic_click');
    } catch {
      // ignore
    }

    setRoomState(res.data);
    setViewMode('WAITING_ROOM');
  };

  // 3. Handle Copy Code
  const handleCopyCode = async () => {
    if (!roomState?.room?.join_code) return;
    try {
      await navigator.clipboard.writeText(roomState.room.join_code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2200);
    } catch {
      // fallback
    }
  };

  // 4. Handle "Start Comm" (ATC Officer only)
  const handleStartComm = async () => {
    if (!roomState?.room?.id) return;
    setIsSubmitting(true);
    setErrorMessage(null);

    const res = await startCommRoom(roomState.room.id);
    setIsSubmitting(false);

    if (res.error) {
      setErrorMessage(res.error);
      return;
    }

    try {
      playRadioTone('mic_click');
    } catch {
      // ignore
    }

    onClose();
    navigate(`/comm/${roomState.room.id}`);
  };

  // 5. Handle "Leave Room"
  const handleLeaveRoom = async () => {
    if (roomState?.room?.id && roomState.currentRole) {
      await leaveCommRoom(roomState.room.id, roomState.currentRole);
    }
    setRoomState(null);
    setViewMode('CHOICE');
    onClose();
  };

  // Find participants for display
  const atcParticipant = roomState?.participants?.find((p) => p.role === 'atc');
  const pilotParticipant = roomState?.participants?.find(
    (p) => p.role === 'pilot' && p.status === 'connected'
  );
  const isCreator = roomState?.isCreator || roomState?.currentRole === 'atc';
  const isPilotReady = Boolean(pilotParticipant);
  const roomStatus = roomState?.room?.status || 'waiting';

  return (
    <div className="comm-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="comm-modal-window" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="comm-modal-header">
          <div className="comm-header-left">
            <div className="comm-radar-icon-wrap">
              <Radio size={18} />
            </div>
            <div>
              <div className="comm-header-title">SafeComm Operational Channel</div>
              <div className="comm-header-subtitle">
                {viewMode === 'CHOICE'
                  ? 'Dual-station ATC & Flight Crew synchronization'
                  : `Channel ${roomState?.room?.join_code || ''} · ${roomState?.room?.frequency || '120.500 MHz'}`}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="comm-modal-close-btn"
            onClick={viewMode === 'WAITING_ROOM' ? handleLeaveRoom : onClose}
            title="Close communication modal"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="comm-modal-body">
          {/* Error Banner */}
          {errorMessage && (
            <div className="comm-error-banner" role="alert">
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{errorMessage}</span>
              <button
                type="button"
                className="comm-error-dismiss"
                onClick={() => setErrorMessage(null)}
                aria-label="Dismiss error"
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* VIEW MODE 1: CHOICE (Create vs Join Comm) */}
          {viewMode === 'CHOICE' && (
            <div className="comm-options-grid">
              {/* Option 1: Create Comm (ATC) */}
              <div className="comm-action-card">
                <div className="comm-card-badge atc">
                  <TowerControl size={12} />
                  <span>Host Station · ATC Officer</span>
                </div>
                <h3 className="comm-card-title">Create Comm</h3>
                <p className="comm-card-desc">
                  Open an active ATC tower frequency, generate a shared join code, and monitor pilot
                  read-back check-in.
                </p>

                <div className="comm-input-group">
                  <label className="comm-input-label" htmlFor="atc-callsign-input">
                    ATC Controller Callsign
                  </label>
                  <input
                    id="atc-callsign-input"
                    type="text"
                    className="comm-input-field"
                    value={atcCallsign}
                    onChange={(e) => setAtcCallsign(e.target.value)}
                    placeholder="e.g. KSFO Tower"
                    maxLength={40}
                  />
                </div>

                <div className="comm-input-group">
                  <span className="comm-input-label">Assigned Sector</span>
                  <div
                    style={{
                      fontSize: '12.5px',
                      color: 'var(--text-secondary)',
                      fontFamily: 'var(--font-mono)',
                      padding: '8px 12px',
                      background: 'var(--bg-subtle)',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-hairline)',
                    }}
                  >
                    KSFO San Francisco · 120.500 MHz
                  </div>
                </div>

                <button
                  type="button"
                  className="comm-btn-submit atc"
                  onClick={handleCreateComm}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      <span>Initializing...</span>
                    </>
                  ) : (
                    <>
                      <TowerControl size={15} />
                      <span>Create Comm Room</span>
                    </>
                  )}
                </button>
              </div>

              {/* Option 2: Join Comm (Pilot) */}
              <div className="comm-action-card">
                <div className="comm-card-badge pilot">
                  <Plane size={12} />
                  <span>Flight Crew · Pilot</span>
                </div>
                <h3 className="comm-card-title">Join Comm</h3>
                <p className="comm-card-desc">
                  Enter an existing communication room code issued by the ATC controller to link your
                  cockpit station.
                </p>

                <div className="comm-input-group">
                  <label className="comm-input-label" htmlFor="join-code-input">
                    Room Join Code
                  </label>
                  <input
                    id="join-code-input"
                    type="text"
                    className="comm-input-field join-code-input"
                    value={joinCodeInput}
                    onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                    placeholder="SFC-..."
                    maxLength={10}
                    autoComplete="off"
                  />
                </div>

                <div className="comm-input-group">
                  <label className="comm-input-label" htmlFor="pilot-callsign-input">
                    Aircraft Callsign
                  </label>
                  <input
                    id="pilot-callsign-input"
                    type="text"
                    className="comm-input-field"
                    value={pilotCallsign}
                    onChange={(e) => setPilotCallsign(e.target.value)}
                    placeholder="e.g. Speedbird 214"
                    maxLength={40}
                  />
                </div>

                <button
                  type="button"
                  className="comm-btn-submit pilot"
                  onClick={handleJoinComm}
                  disabled={isSubmitting || !joinCodeInput.trim()}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      <span>Connecting...</span>
                    </>
                  ) : (
                    <>
                      <Plane size={15} />
                      <span>Join Comm Room</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* VIEW MODE 2: SHARED WAITING ROOM */}
          {viewMode === 'WAITING_ROOM' && roomState && (
            <div className="comm-waiting-room">
              {/* Channel Status Bar */}
              <div className="comm-status-strip">
                <span
                  className={`comm-status-badge ${
                    roomStatus === 'active'
                      ? 'active'
                      : isPilotReady
                      ? 'ready'
                      : 'waiting'
                  }`}
                >
                  <span className="comm-pulse-beacon" />
                  {roomStatus === 'active'
                    ? '● ACTIVE COMMUNICATION SESSION'
                    : isPilotReady
                    ? '● READY FOR CLEARANCE (2/2 CONNECTED)'
                    : '● AWAITING FLIGHT CREW (1/2 CONNECTED)'}
                </span>

                <span className="comm-channel-meta">
                  {roomState.room.airport} · {roomState.room.frequency}
                </span>
              </div>

              {/* Join Code Hero Banner with Copy */}
              <div className="comm-code-hero">
                <span className="comm-code-hero-label">Communication Join Code</span>
                <div className="comm-code-display-row">
                  <div className="comm-code-number">{roomState.room.join_code}</div>
                  <button
                    type="button"
                    className={`comm-copy-btn ${copiedCode ? 'copied' : ''}`}
                    onClick={handleCopyCode}
                    title="Copy Join Code to Clipboard"
                    aria-label="Copy Join Code"
                  >
                    {copiedCode ? <Check size={14} /> : <Copy size={14} />}
                    <span>{copiedCode ? 'Copied' : 'Copy Code'}</span>
                  </button>
                </div>
                <div className="comm-code-hint">
                  Share this code with the Flight Crew. The pilot enters it under "Join Comm" to
                  link into this operational channel.
                </div>
              </div>

              {/* Dual Station Participant Cards */}
              <div className="comm-stations-grid">
                {/* Station 1: ATC Controller */}
                <div
                  className={`comm-station-card ${
                    roomState.currentRole === 'atc' ? 'is-you' : ''
                  }`}
                >
                  <div className="comm-station-header">
                    <div className="comm-station-role">
                      <TowerControl size={13} color="#0071E3" />
                      <span>ATC Controller</span>
                    </div>
                    {roomState.currentRole === 'atc' && (
                      <span className="comm-station-badge-you">You</span>
                    )}
                  </div>
                  <div className="comm-station-callsign">
                    {atcParticipant?.callsign || atcCallsign}
                  </div>
                  <div className="comm-station-presence">
                    <span className="comm-presence-dot connected" />
                    <span>Station Online · KSFO Ground/Tower</span>
                  </div>
                </div>

                {/* Station 2: Pilot */}
                <div
                  className={`comm-station-card ${
                    roomState.currentRole === 'pilot' ? 'is-you' : ''
                  }`}
                >
                  <div className="comm-station-header">
                    <div className="comm-station-role">
                      <Plane size={13} color={isPilotReady ? '#107C41' : '#FF9F0A'} />
                      <span>Flight Crew (Pilot)</span>
                    </div>
                    {roomState.currentRole === 'pilot' && (
                      <span className="comm-station-badge-you">You</span>
                    )}
                  </div>
                  <div
                    className="comm-station-callsign"
                    style={{
                      color: isPilotReady ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      fontStyle: isPilotReady ? 'normal' : 'italic',
                    }}
                  >
                    {pilotParticipant?.callsign || 'Waiting for Pilot to join...'}
                  </div>
                  <div className="comm-station-presence">
                    <span
                      className={`comm-presence-dot ${
                        isPilotReady ? 'connected' : 'waiting'
                      }`}
                    />
                    <span>
                      {isPilotReady
                        ? 'Transponder Linked · Cockpit Connected'
                        : 'Standby on Frequency...'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Action Strip */}
              <div className="comm-modal-actions">
                <button
                  type="button"
                  className="comm-btn-leave"
                  onClick={handleLeaveRoom}
                  title="Leave this communication channel"
                >
                  <LogOut size={14} />
                  <span>Leave Room</span>
                </button>

                {/* ATC Controller Start Comm Button */}
                {isCreator ? (
                  <button
                    type="button"
                    className="comm-btn-start"
                    onClick={handleStartComm}
                    disabled={!isPilotReady || roomStatus === 'active' || isSubmitting}
                    title={
                      !isPilotReady
                        ? 'Awaiting Flight Crew check-in before session can start'
                        : roomStatus === 'active'
                        ? 'Communication session already active'
                        : 'Start synchronized ATC and Pilot communication session'
                    }
                  >
                    <Play size={14} fill="currentColor" />
                    <span>
                      {roomStatus === 'active'
                        ? 'Comm Session Active'
                        : isPilotReady
                        ? 'Start Comm'
                        : 'Awaiting Pilot...'}
                    </span>
                  </button>
                ) : (
                  <div className="comm-waiting-pilot-notice">
                    {roomStatus === 'active' ? (
                      <span style={{ color: '#0071E3', fontWeight: 600 }}>
                        ● ATC Controller initiated communication session
                      </span>
                    ) : (
                      <span>Awaiting ATC Controller to start communication session...</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
