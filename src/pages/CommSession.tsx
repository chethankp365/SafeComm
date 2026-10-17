import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Radio,
  TowerControl,
  Plane,
  Clock,
  LogOut,
  Copy,
  Check,
  ShieldCheck,
  FileText,
  Mic,
  MicOff,
  AlertTriangle,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Lock,
  Unlock,
  Send,
  Volume2,
  VolumeX,
  Star,
} from 'lucide-react';
import {
  type CommRoomState,
  type CommRole,
  fetchCommRoomState,
  subscribeToCommRoom,
  endCommRoom,
  getActiveSession,
  clearActiveSession,
  submitCommFeedback,
} from '../lib/commRooms';
import {
  CommAudioSession,
  type CommTranscriptEntry,
  type AudioConnectionStatus,
  type PeerAudioState,
  type SpeechRecognitionStatus,
  isBrowserSpeechRecognitionSupported,
  type SyncedReadbackVerdict,
} from '../lib/commAudio';
import { compareTranscriptChronology } from '../lib/commTranscripts';
import {
  extractInstructions,
  extractWithLocalFallback,
  extractWithLocalRules,
  type ExtractionResult,
} from '../lib/llmExtractor';
import {
  claimVerificationAlert,
  formatVerificationAlertMessage,
  getVerificationFeedbackPolicy,
  loadPersistedReadbackVerdict,
  syncTransmissionToSupabase,
  verificationAlertKey,
  verifyTranscriptTimeline,
  type VerificationVerdictStub,
} from '../lib/databaseSync';
import { supabase } from '../lib/supabase';
import {
  playRadioTone,
  speakSafeCommVerification,
  shouldSpeakSafeCommAlert,
  onVoicesChanged,
  getAvailableVoices,
  resumeSpeech,
  cancelAllSpeech,
} from '../lib/speechAudio';
import './CommSession.css';

function formatInstruction(instruction: ReturnType<typeof extractWithLocalRules>['instructions'][number]): string {
  const details = [
    instruction.action?.replace(/_/g, ' '),
    instruction.direction,
  ].filter(Boolean);
  const prefix = details.length > 0 ? `${details.join(' ')} ` : '';
  return `${instruction.type}: ${prefix}${instruction.value}`;
}

function describeExtraction(extraction: ExtractionResult | null | undefined): string {
  if (!extraction) return 'not paired';
  const model = extraction.providerModel ? ` · ${extraction.providerModel}` : '';
  return `${extraction.parserType}${model}${extraction.extractionFailed ? ' · failed; UNVERIFIED' : ''}`;
}

function verificationDebugEnabled(): boolean {
  return Boolean(
    import.meta.env?.DEV ||
    (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('verifyDebug'))
  );
}

function verificationTrace(event: string, details: Record<string, string | number | boolean | undefined>): void {
  if (verificationDebugEnabled()) {
    console.info('[SafeComm/Verify]', event, details);
  }
}

interface VerificationCandidate {
  entry: CommTranscriptEntry;
  controllerEntry: CommTranscriptEntry | null;
  controllerExtraction: ExtractionResult | null;
  pilotExtraction: ExtractionResult;
  verdict: VerificationVerdictStub;
  message: string;
}

export const CommSession: React.FC = () => {
  const { roomId: urlRoomId } = useParams<{ roomId?: string }>();
  const navigate = useNavigate();

  // Active session fallback recovery
  const storedSession = getActiveSession();
  const [canonicalRoomId, setCanonicalRoomId] = useState<string>(() => {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(urlRoomId || '');
    if (isUuid) return urlRoomId!;
    return storedSession?.roomId || urlRoomId || '';
  });
  const activeRoomId = canonicalRoomId || urlRoomId || storedSession?.roomId || '';

  // Component State
  const [roomState, setRoomState] = useState<CommRoomState | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [isEnding, setIsEnding] = useState<boolean>(false);
  const [sessionEnded, setSessionEnded] = useState<boolean>(false);
  const [showEndConfirm, setShowEndConfirm] = useState<boolean>(false);

  // Five-Star Feedback State
  const [rating, setRating] = useState<number>(0);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [feedbackText, setFeedbackText] = useState<string>('');
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState<boolean>(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState<boolean>(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // Live Timer State
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [zuluTime, setZuluTime] = useState<string>('');

  // WebRTC Audio, Mic & Speech Recognition State
  const [audioStatus, setAudioStatus] = useState<AudioConnectionStatus>('standby');
  const [statusMessage, setStatusMessage] = useState<string>('Initializing aeronautical transceivers...');
  const [isAudioBlocked, setIsAudioBlocked] = useState<boolean>(false);
  const [isLocalAudioReady, setIsLocalAudioReady] = useState<boolean>(false);
  const [isRetryingVoice, setIsRetryingVoice] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [isPTTLocked, setIsPTTLocked] = useState<boolean>(false);
  const [peerAudio, setPeerAudio] = useState<PeerAudioState>({
    isMuted: false,
    isTransmitting: false,
    isOnline: false,
  });

  // Transcript Stream State
  const [transcripts, setTranscripts] = useState<CommTranscriptEntry[]>([]);
  const [transcriptExtractions, setTranscriptExtractions] = useState<Record<string, ExtractionResult>>({});
  const [syncedReadbackVerdicts, setSyncedReadbackVerdicts] = useState<Record<string, SyncedReadbackVerdict>>({});
  const [settledUnpairedReadbacks, setSettledUnpairedReadbacks] = useState<Set<string>>(new Set());
  const [visualSafetyAlert, setVisualSafetyAlert] = useState<{
    roomId: string;
    pilotTransmissionId: string;
    outcome: VerificationVerdictStub['outcome'];
    message: string;
  } | null>(null);
  const [visualSafetyAlertQueue, setVisualSafetyAlertQueue] = useState<NonNullable<typeof visualSafetyAlert>[]>([]);
  const [interimSpeech, setInterimSpeech] = useState<string>('');
  const [isLocalInterim, setIsLocalInterim] = useState<boolean>(false);
  const [manualInput, setManualInput] = useState<string>('');
  const [hasRemoteTrack, setHasRemoteTrack] = useState<boolean>(false);
  const [isRemoteAudioActive, setIsRemoteAudioActive] = useState<boolean>(false);
  const [speechStatus, setSpeechStatus] = useState<SpeechRecognitionStatus>(
    isBrowserSpeechRecognitionSupported() ? 'idle' : 'unsupported'
  );
  const [livePilotTranscriptIds, setLivePilotTranscriptIds] = useState<Set<string>>(new Set());

  // Voice playback & deduplication state
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const spokenVerdictsRef = useRef<Set<string>>(new Set());
  const visualAlertsRef = useRef<Set<string>>(new Set());
  const syncedVerdictsRef = useRef<Set<string>>(new Set());
  const publishedVerdictsRef = useRef<Set<string>>(new Set());
  const persistedVerdictLookupsRef = useRef<Set<string>>(new Set());
  const voiceQueueRef = useRef<Array<{
    roomId: string;
    transcriptId: string;
    outcome: VerificationVerdictStub['outcome'];
    message: string;
  }>>([]);
  const voiceQueueRunningRef = useRef(false);
  const isTransmittingRef = useRef(false);
  const pendingReadbackTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const extractionPromisesRef = useRef<Map<string, Promise<ExtractionResult>>>(new Map());

  // Refs
  const audioSessionRef = useRef<CommAudioSession | null>(null);
  const subscriptionCleanupRef = useRef<(() => void) | null>(null);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const pttActiveRef = useRef(false);

  const currentRole: CommRole = roomState?.currentRole || storedSession?.role || 'atc';
  const atcParticipant = roomState?.participants?.find((p) => p.role === 'atc');
  const pilotParticipant = roomState?.participants?.find((p) => p.role === 'pilot');
  const myCallsign = currentRole === 'atc'
    ? (atcParticipant?.callsign || 'KSFO Tower')
    : (pilotParticipant?.callsign || 'Flight Crew');
  const audioInitializationRef = useRef({
    role: currentRole,
    roomRole: roomState?.currentRole,
    callsign: myCallsign,
  });
  useEffect(() => {
    audioInitializationRef.current = {
      role: currentRole,
      roomRole: roomState?.currentRole,
      callsign: myCallsign,
    };
  }, [currentRole, roomState?.currentRole, myCallsign]);

  useEffect(() => {
    isTransmittingRef.current = isTransmitting;
  }, [isTransmitting]);

  // Peer session ended callback
  const handlePeerSessionEnded = useCallback(() => {
    cancelAllSpeech();
    if (audioSessionRef.current) {
      audioSessionRef.current.cleanup();
      audioSessionRef.current = null;
    }
    setIsLocalAudioReady(false);
    clearActiveSession();
    setSessionEnded(true);
    setShowEndConfirm(false);
    try {
      playRadioTone('mic_click');
    } catch {
      // ignore
    }
  }, []);

  const handleRetryVoice = useCallback(async () => {
    const session = audioSessionRef.current;
    if (!session || isRetryingVoice) return;
    setIsRetryingVoice(true);
    setAudioStatus('connecting');
    setStatusMessage('Retrying Agora voice connection...');
    try {
      await session.initialize();
      if (audioSessionRef.current === session) {
        setIsLocalAudioReady(session.canTransmit());
      }
    } catch (error: unknown) {
      console.error('[SafeComm/Audio] Voice connection retry failed unexpectedly:', error);
      if (audioSessionRef.current === session) {
        setIsLocalAudioReady(false);
        setAudioStatus('standby');
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsRetryingVoice(false);
    }
  }, [isRetryingVoice]);

  // 1. Initial Load & Recovery
  useEffect(() => {
    if (!activeRoomId) {
      setLoading(false);
      setErrorMessage('No active communication room identifier provided.');
      return;
    }

    let isMounted = true;
    const initialRole: CommRole = storedSession?.role || 'atc';

    // Fetch initial room state
    fetchCommRoomState(activeRoomId, initialRole)
      .then((state) => {
        if (!isMounted) return;
        if (!state) {
          setErrorMessage(`Communication room "${activeRoomId}" was not found or has concluded.`);
          setLoading(false);
          return;
        }

        // Canonical UUID normalization across tabs and browsers
        if (state.room?.id && state.room.id !== canonicalRoomId) {
          setCanonicalRoomId(state.room.id);
          if (urlRoomId !== state.room.id) {
            navigate(`/comm/${state.room.id}`, { replace: true });
          }
          if (audioSessionRef.current) {
            audioSessionRef.current.setRoomId(state.room.id);
          }
        }

        // Check if room was already ended
        if (state.room.status === 'completed' || state.room.status === 'abandoned') {
          handlePeerSessionEnded();
        }

        setRoomState(state);
        setLoading(false);

        // Setup real-time and presence subscription on canonical UUID
        const realRoomId = state.room?.id || activeRoomId;
        subscriptionCleanupRef.current = subscribeToCommRoom(realRoomId, initialRole, (updated) => {
          if (!isMounted) return;

          // Check if ended
          if (updated.room.status === 'completed' || updated.room.status === 'abandoned') {
            handlePeerSessionEnded();
          }

          setRoomState(updated);
        });
      })
      .catch((err) => {
        if (!isMounted) return;
        setErrorMessage((err as Error).message || 'Failed to connect to communication channel');
        setLoading(false);
      });

    return () => {
      isMounted = false;
      if (subscriptionCleanupRef.current) {
        subscriptionCleanupRef.current();
        subscriptionCleanupRef.current = null;
      }
    };
  }, [activeRoomId, storedSession?.role, handlePeerSessionEnded, canonicalRoomId, urlRoomId, navigate]);

  // 2. Elapsed Time & Zulu Clock Loop
  useEffect(() => {
    const updateZulu = () => {
      const now = new Date();
      const h = String(now.getUTCHours()).padStart(2, '0');
      const m = String(now.getUTCMinutes()).padStart(2, '0');
      const s = String(now.getUTCSeconds()).padStart(2, '0');
      setZuluTime(`${h}:${m}:${s} UTC`);
    };

    updateZulu();
    const clockInterval = setInterval(updateZulu, 1000);

    // Elapsed timer (active session)
    let elapsedTimer: ReturnType<typeof setInterval> | null = null;
    if (roomState?.room?.status === 'active' && !sessionEnded) {
      elapsedTimer = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    }

    return () => {
      clearInterval(clockInterval);
      if (elapsedTimer) clearInterval(elapsedTimer);
    };
  }, [roomState?.room?.status, sessionEnded]);

  // Voice list subscription for female safety assistant speech synthesis
  useEffect(() => {
    let isMounted = true;
    const unsubscribe = onVoicesChanged((voices) => {
      if (isMounted && voices && voices.length > 0) {
        setAvailableVoices(voices);
      }
    });

    getAvailableVoices().then((voices) => {
      if (isMounted && voices && voices.length > 0) {
        setAvailableVoices(voices);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  // 3. Initialize Agora Audio & Speech Recognition Session
  useEffect(() => {
    // Only initialize when roomState has loaded with canonical room UUID and verified role
    if (loading || !roomState?.room?.id || sessionEnded) return;

    const targetRoomId = roomState.room.id;
    const { role, roomRole, callsign } = audioInitializationRef.current;
    const targetRole: CommRole = roomRole || role;
    const targetCallsign = callsign;

    if (!audioSessionRef.current) {
      let session: CommAudioSession;
      session = new CommAudioSession(
        targetRoomId,
        targetRole,
        targetCallsign,
        {
          onStatusChange: (status, message) => {
            setAudioStatus(status);
            setIsLocalAudioReady(session.canTransmit());
            if (message) setStatusMessage(message);
            if (message?.startsWith('Microphone control failed')) {
              setIsMuted(true);
              setIsTransmitting(false);
              setIsPTTLocked(false);
            }
          },
          onRemoteStream: () => {},
          onRemoteTrackReceived: (hasTrack) => {
            setHasRemoteTrack(hasTrack);
          },
          onSpeechRecognitionStatus: (status) => {
            setSpeechStatus(status);
          },
          onPeerAudioState: (peer) => {
            setPeerAudio(peer);
          },
          onTranscriptReceived: (entry) => {
            if (entry.role === 'pilot') {
              setLivePilotTranscriptIds((current) => {
                if (current.has(entry.id)) return current;
                return new Set(current).add(entry.id);
              });
              if (!pendingReadbackTimersRef.current.has(entry.id)) {
                const timer = setTimeout(() => {
                  pendingReadbackTimersRef.current.delete(entry.id);
                  setSettledUnpairedReadbacks((current) => new Set(current).add(entry.id));
                }, 1500);
                pendingReadbackTimersRef.current.set(entry.id, timer);
              }
            }
            verificationTrace('transcript received', {
              roomId: entry.roomId,
              transcriptId: entry.id,
              role: entry.role,
              isFinal: entry.isFinal,
              textLength: entry.text.length,
            });
            setTranscripts((prev) => {
              if (prev.some((t) => t.id === entry.id)) return prev;
              return [...prev, entry].sort(compareTranscriptChronology);
            });
            setInterimSpeech('');
          },
          onInterimTranscript: (text, isLocal) => {
            setInterimSpeech(text);
            setIsLocalInterim(isLocal);
          },
          onTranscriptsSync: (synced) => {
            setTranscripts(synced);
          },
          onVerificationReceived: (result) => {
            if (result.roomId !== targetRoomId) return;
            setSyncedReadbackVerdicts((current) => ({
              ...current,
              [result.pilotTransmissionId]: result,
            }));
          },
          onSessionEnded: handlePeerSessionEnded,
          onAudioBlocked: (blocked) => {
            setIsAudioBlocked(blocked);
          },
          onRemoteAudioActive: (isActive) => {
            setIsRemoteAudioActive(isActive);
          },
        }
      );

      audioSessionRef.current = session;
      void session.initialize()
        .then(() => {
          if (audioSessionRef.current === session) {
            setIsLocalAudioReady(session.canTransmit());
          }
        })
        .catch((error: unknown) => {
          console.error('[SafeComm/Audio] Voice initialization failed unexpectedly:', error);
          if (audioSessionRef.current === session) {
            setIsLocalAudioReady(false);
            setAudioStatus('standby');
            setStatusMessage(error instanceof Error ? error.message : String(error));
          }
        });
    }

    return () => {
      if (audioSessionRef.current) {
        audioSessionRef.current.cleanup();
        audioSessionRef.current = null;
      }
    };
  }, [loading, roomState?.room?.id, sessionEnded, handlePeerSessionEnded]);

  // Dynamically update role & callsign on the existing session without restarting Agora
  useEffect(() => {
    if (audioSessionRef.current) {
      if (currentRole) {
        audioSessionRef.current.setRole(currentRole);
      }
      if (myCallsign) {
        audioSessionRef.current.setCallsign(myCallsign);
      }
    }
  }, [currentRole, myCallsign]);

  // 4. Auto-scroll transcript feed on new messages
  useEffect(() => {
    if (transcriptListRef.current) {
      transcriptListRef.current.scrollTop = transcriptListRef.current.scrollHeight;
    }
  }, [transcripts, interimSpeech]);

  // Enable Audio on User Interaction / Tap
  const handleEnableAudio = useCallback(async () => {
    resumeSpeech();
    if (audioSessionRef.current) {
      const ok = await audioSessionRef.current.resumeRemoteAudio();
      if (ok) {
        setIsAudioBlocked(false);
      }
    }
  }, []);

  // PTT Actions
  const handlePTTStart = useCallback(() => {
    resumeSpeech();
    if (!audioSessionRef.current || !audioSessionRef.current.canTransmit() || isMuted || isPTTLocked || pttActiveRef.current) return;
    pttActiveRef.current = true;
    if (isAudioBlocked) handleEnableAudio();
    if (!audioSessionRef.current.startPTT()) {
      pttActiveRef.current = false;
      return;
    }
    setIsTransmitting(true);
  }, [isMuted, isPTTLocked, isAudioBlocked, handleEnableAudio]);

  const handlePTTEnd = useCallback(() => {
    if (isPTTLocked) return;
    if (!pttActiveRef.current) return;
    pttActiveRef.current = false;
    if (!audioSessionRef.current) return;
    audioSessionRef.current.stopPTT();
    setIsTransmitting(false);
  }, [isPTTLocked]);

  // 5. Spacebar Push-To-Talk Keyboard Support & Window Blur Release
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (targetTag === 'input' || targetTag === 'textarea') return;

      if (e.code === 'Space' && !e.repeat && !isTransmitting && !isPTTLocked && !isMuted && audioSessionRef.current?.canTransmit()) {
        e.preventDefault();
        handlePTTStart();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (targetTag === 'input' || targetTag === 'textarea') return;

      if (e.code === 'Space' && !isPTTLocked) {
        e.preventDefault();
        handlePTTEnd();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    const handleWindowBlur = () => {
      if (!isPTTLocked && isTransmitting) {
        handlePTTEnd();
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden && !isPTTLocked && isTransmitting) {
        handlePTTEnd();
      }
    };

    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isTransmitting, isPTTLocked, isMuted, handlePTTStart, handlePTTEnd]);

  // 6. Listen for available browser speech synthesis voices & cancel speech on unmount
  useEffect(() => {
    const unsub = onVoicesChanged((voices) => {
      setAvailableVoices(voices);
    });
    return () => {
      unsub();
      cancelAllSpeech();
    };
  }, []);

  // Mic Mute Toggle
  const handleToggleMute = () => {
    if (!audioSessionRef.current || !audioSessionRef.current.canTransmit()) return;
    if (isAudioBlocked) handleEnableAudio();
    const muted = audioSessionRef.current.toggleMute();
    setIsMuted(muted);
    if (muted) setIsTransmitting(false);
  };

  // PTT Lock / Open Mic Toggle
  const handleTogglePTTLock = () => {
    if (!audioSessionRef.current || !audioSessionRef.current.canTransmit()) return;
    if (isAudioBlocked) handleEnableAudio();
    const locked = audioSessionRef.current.togglePTTLock();
    pttActiveRef.current = false;
    setIsPTTLocked(locked);
    setIsTransmitting(locked && !isMuted);
  };

  // Manual Dispatch Transmission (Strictly Station Role Locked)
  const handleManualDispatch = (e: React.FormEvent) => {
    e.preventDefault();
    resumeSpeech();
    const text = manualInput.trim();
    if (!text || !audioSessionRef.current) return;

    try {
      playRadioTone('mic_click');
    } catch {
      // ignore
    }

    // Role and callsign are locked to authenticated participant's station
    audioSessionRef.current.transmitManualText(text);
    setManualInput('');
  };

  // Copy Room Code
  const handleCopyCode = async () => {
    if (!roomState?.room?.join_code) return;
    try {
      await navigator.clipboard.writeText(roomState.room.join_code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // fallback
    }
  };

  // End Comm Action (Prompts Confirmation Modal to prevent accidental termination)
  const handleEndComm = () => {
    if (sessionEnded) return;
    setShowEndConfirm(true);
  };

  // Execution upon user confirmation
  const executeEndComm = async () => {
    if (!activeRoomId || isEnding) return;
    setIsEnding(true);

    try {
      playRadioTone('mic_click');
    } catch {
      // ignore
    }

    // 1. Notify peer station immediately over WebRTC signal
    if (audioSessionRef.current) {
      try {
        audioSessionRef.current.broadcastSessionEnded();
      } catch {
        // ignore
      }
      audioSessionRef.current.cleanup();
      audioSessionRef.current = null;
    }

    // 2. Terminate speech synthesis
    cancelAllSpeech();

    // 3. Conclude room in database
    await endCommRoom(activeRoomId);

    // 4. Clear active session tokens
    clearActiveSession();

    setIsEnding(false);
    setShowEndConfirm(false);
    setSessionEnded(true);
  };

  // Submit Five-Star Feedback
  const handleSubmitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rating === 0 || isSubmittingFeedback || feedbackSubmitted) return;

    setIsSubmittingFeedback(true);
    setFeedbackError(null);

    const res = await submitCommFeedback(activeRoomId, rating, feedbackText, currentRole);
    setIsSubmittingFeedback(false);

    if (res.success) {
      setFeedbackSubmitted(true);
    } else {
      setFeedbackError(res.error || 'Failed to persist feedback. Please retry.');
    }
  };

  const starLabels: Record<number, string> = {
    1: 'Poor — Readback issues & confusion',
    2: 'Fair — Partial clarity / omissions',
    3: 'Good — Standard operational readback',
    4: 'Very Good — Crisp aeronautical communication',
    5: 'Exceptional — Flawless readback verification',
  };

  // Exit back to normal dashboard
  const handleReturnDashboard = () => {
    cancelAllSpeech();
    if (audioSessionRef.current) {
      audioSessionRef.current.cleanup();
      audioSessionRef.current = null;
    }
    clearActiveSession();
    navigate('/dashboard');
  };

  // Formatting Elapsed Time (MM:SS)
  const formatElapsed = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // Real presence state
  const isAtcOnline = roomState?.presence?.atcOnline ?? Boolean(atcParticipant);
  const isPilotOnline = roomState?.presence?.pilotOnline ?? (Boolean(pilotParticipant) && pilotParticipant?.status === 'connected');

  // --------------------------------------------------------------------------
  // Structured transcript extraction and deterministic verification
  // --------------------------------------------------------------------------
  useEffect(() => {
    for (const entry of transcripts) {
      if (!entry.isFinal || entry.roomId !== activeRoomId || transcriptExtractions[entry.id]) continue;
      if (extractionPromisesRef.current.has(entry.id)) continue;

      const extractionPromise = entry.role === currentRole
        ? extractInstructions(entry.text, {
            roomId: entry.roomId,
            role: entry.role,
            transcriptId: entry.id,
          })
        : Promise.resolve(extractWithLocalFallback(entry.text));
      extractionPromisesRef.current.set(entry.id, extractionPromise);
      void extractionPromise.then((extraction) => {
        setTranscriptExtractions((current) =>
          current[entry.id] ? current : { ...current, [entry.id]: extraction }
        );
      }).finally(() => {
        extractionPromisesRef.current.delete(entry.id);
      });
    }
  }, [transcripts, transcriptExtractions, activeRoomId, currentRole]);

  const localTranscriptVerification = verifyTranscriptTimeline(
    transcripts,
    transcriptExtractions,
    activeRoomId
  );
  const {
    verdicts: localTransmissionVerdicts,
    latestAtcEntry,
    latestPilotEntry,
  } = localTranscriptVerification;
  const syncedActiveVerification = latestPilotEntry
    ? syncedReadbackVerdicts[latestPilotEntry.id] || null
    : null;
  const activeVerdict =
    syncedActiveVerification?.verdict || localTranscriptVerification.activeVerdict;
  const transmissionVerdicts = {
    ...localTransmissionVerdicts,
    ...Object.fromEntries(
      Object.values(syncedReadbackVerdicts).map((result) => [
        result.pilotTransmissionId,
        result.verdict,
      ])
    ),
  };
  const localMatchingAtcEntry = localTranscriptVerification.matchingAtcEntry;
  const matchingAtcEntry =
    syncedActiveVerification?.controllerTransmissionId
      ? transcripts.find((entry) => entry.id === syncedActiveVerification.controllerTransmissionId) || localMatchingAtcEntry
      : localMatchingAtcEntry;
  const latestAtcExtraction = latestAtcEntry
    ? transcriptExtractions[latestAtcEntry.id] || null
    : null;
  const localMatchingAtcExtraction = localMatchingAtcEntry
    ? transcriptExtractions[localMatchingAtcEntry.id] || null
    : null;
  const matchingAtcExtraction =
    syncedActiveVerification?.controllerExtraction || localMatchingAtcExtraction;
  const localLatestPilotExtraction = latestPilotEntry
    ? transcriptExtractions[latestPilotEntry.id] || null
    : null;
  const latestPilotExtraction =
    syncedActiveVerification?.pilotExtraction || localLatestPilotExtraction;
  const isVerificationPending =
    localTranscriptVerification.isPending && !syncedActiveVerification;
  const activeVerificationMessage = activeVerdict
    ? (syncedActiveVerification
        ? syncedActiveVerification.message
        : formatVerificationAlertMessage(activeVerdict, matchingAtcExtraction, latestPilotExtraction))
    : '';
  const verificationCandidates: VerificationCandidate[] = transcripts.flatMap((entry) => {
    if (
      entry.role !== 'pilot' ||
      !entry.isFinal ||
      entry.roomId !== activeRoomId ||
      !livePilotTranscriptIds.has(entry.id)
    ) return [];

    const shared = syncedReadbackVerdicts[entry.id];
    const verdict = shared?.verdict || localTransmissionVerdicts[entry.id];
    const pilotExtraction = shared?.pilotExtraction || transcriptExtractions[entry.id] || null;
    const controllerEntry = shared
      ? (shared.controllerTransmissionId
          ? transcripts.find((candidate) => candidate.id === shared.controllerTransmissionId) || null
          : null)
      : (localTranscriptVerification.atcByPilotId[entry.id] || null);
    const controllerExtraction = shared?.controllerExtraction ||
      (controllerEntry ? transcriptExtractions[controllerEntry.id] || null : null);

    if (
      !verdict ||
      !pilotExtraction ||
      (!shared && localTranscriptVerification.isPending) ||
      (!controllerEntry &&
        verdict.outcome === 'UNVERIFIED' &&
        !settledUnpairedReadbacks.has(entry.id)) ||
      (controllerEntry && !controllerExtraction)
    ) return [];

    return [{
      entry,
      controllerEntry,
      controllerExtraction,
      pilotExtraction,
      verdict,
      message: shared?.message || formatVerificationAlertMessage(verdict, controllerExtraction, pilotExtraction),
    }];
  });

  useEffect(() => {
    if (currentRole === 'pilot' || !canonicalRoomId || !activeRoomId) return;

    for (const entry of transcripts) {
      if (entry.role !== 'pilot' || !entry.isFinal || entry.roomId !== activeRoomId) continue;
      const pilotExtraction = transcriptExtractions[entry.id];
      if (!pilotExtraction) continue;
      const lookupKey = `${canonicalRoomId}:${entry.id}`;
      if (persistedVerdictLookupsRef.current.has(lookupKey)) continue;
      persistedVerdictLookupsRef.current.add(lookupKey);

      void loadPersistedReadbackVerdict(canonicalRoomId, entry.id).then(({ verdict, error }) => {
        if (error) {
          console.error('[SafeComm/Sentinel] Error loading persisted verdict:', error);
          return;
        }
        if (!verdict) return;

        const controllerEntry = localTranscriptVerification.atcByPilotId[entry.id] || null;
        const controllerExtraction = controllerEntry
          ? transcriptExtractions[controllerEntry.id] || null
          : null;
        const message = /^(?:MATCH|UNVERIFIED|[A-Z ]+ MISMATCH) —/.test(verdict.explanation)
          ? verdict.explanation
          : formatVerificationAlertMessage(verdict, controllerExtraction, pilotExtraction);
        setSyncedReadbackVerdicts((current) => {
          if (current[entry.id]) return current;
          return {
            ...current,
            [entry.id]: {
              roomId: activeRoomId,
              pilotTransmissionId: entry.id,
              controllerTransmissionId: controllerEntry?.id || null,
              message,
              controllerExtraction,
              pilotExtraction,
              verdict,
            },
          };
        });
        verificationTrace('persisted verdict restored', {
          roomId: activeRoomId,
          transcriptId: entry.id,
          verdict: verdict.outcome,
        });
      });
    }
  }, [
    currentRole,
    canonicalRoomId,
    activeRoomId,
    transcripts,
    transcriptExtractions,
    localTranscriptVerification.atcByPilotId,
  ]);

  useEffect(() => {
    if (currentRole !== 'pilot' || sessionEnded) return;
    for (const candidate of verificationCandidates) {
      const publicationKey = `${activeRoomId}:${candidate.entry.id}:${candidate.controllerEntry?.id || 'unpaired'}:${candidate.verdict.outcome}`;
      if (publishedVerdictsRef.current.has(publicationKey)) continue;

      const result: SyncedReadbackVerdict = {
        roomId: activeRoomId,
        pilotTransmissionId: candidate.entry.id,
        controllerTransmissionId: candidate.controllerEntry?.id || null,
        message: candidate.message,
        controllerExtraction: candidate.controllerExtraction,
        pilotExtraction: candidate.pilotExtraction,
        verdict: candidate.verdict,
      };
      if (audioSessionRef.current?.publishVerification(result)) {
        publishedVerdictsRef.current.add(publicationKey);
        verificationTrace('authoritative verdict broadcast', {
          roomId: activeRoomId,
          transcriptId: candidate.entry.id,
          instructionId: candidate.controllerEntry?.id,
          verdict: candidate.verdict.outcome,
        });
      }
    }
  }, [
    currentRole,
    verificationCandidates,
    sessionEnded,
    activeRoomId,
    audioStatus,
  ]);

  useEffect(() => {
    const newAlerts = verificationCandidates.flatMap((candidate) => {
      const feedbackPolicy = getVerificationFeedbackPolicy(candidate.verdict.outcome);
      if (!feedbackPolicy.notificationOutcome) return [];
      const alertKey = verificationAlertKey(
        activeRoomId,
        `${candidate.entry.id}:${feedbackPolicy.notificationOutcome}`
      );
      if (!claimVerificationAlert(visualAlertsRef.current, alertKey)) return [];
      return [{
        roomId: activeRoomId,
        pilotTransmissionId: candidate.entry.id,
        outcome: feedbackPolicy.notificationOutcome,
        message: candidate.message,
      }];
    });
    if (newAlerts.length > 0) {
      setVisualSafetyAlertQueue((current) => [...current, ...newAlerts]);
    }
  }, [verificationCandidates, activeRoomId]);

  useEffect(() => {
    if (visualSafetyAlert || visualSafetyAlertQueue.length === 0) return;
    setVisualSafetyAlert(visualSafetyAlertQueue[0]);
    setVisualSafetyAlertQueue((current) => current.slice(1));
  }, [visualSafetyAlert, visualSafetyAlertQueue]);

  useEffect(() => {
    if (!visualSafetyAlert) return;
    verificationTrace('visual alert emitted', {
      roomId: visualSafetyAlert.roomId,
      transcriptId: visualSafetyAlert.pilotTransmissionId,
      verdict: visualSafetyAlert.outcome,
    });
    const timeout = window.setTimeout(() => setVisualSafetyAlert(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [visualSafetyAlert]);

  useEffect(() => {
    if (visualSafetyAlert && visualSafetyAlert.roomId !== activeRoomId) {
      setVisualSafetyAlert(null);
    }
    setVisualSafetyAlertQueue((current) => current.filter((alert) => alert.roomId === activeRoomId));
  }, [visualSafetyAlert, activeRoomId]);

  // --------------------------------------------------------------------------
  // SafeComm Assistant Voice Queue
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (sessionEnded) return;
    for (const candidate of verificationCandidates) {
      const feedbackPolicy = getVerificationFeedbackPolicy(candidate.verdict.outcome);
      if (!feedbackPolicy.speakWarning || !shouldSpeakSafeCommAlert(candidate.verdict.outcome)) continue;
      const verdictKey = verificationAlertKey(activeRoomId, candidate.entry.id);
      if (spokenVerdictsRef.current.has(verdictKey)) continue;
      spokenVerdictsRef.current.add(verdictKey);
      verificationTrace('deterministic verdict finalized', {
        roomId: activeRoomId,
        transcriptId: candidate.entry.id,
        instructionId: candidate.controllerEntry?.id,
        callsign: candidate.pilotExtraction.callsign,
        verdict: candidate.verdict.outcome,
        matchedCount: candidate.verdict.matchedFields.length,
        mismatchCount: candidate.verdict.mismatchedFields.length,
        missingCount: candidate.verdict.omittedFields?.length || 0,
      });
      voiceQueueRef.current.push({
        roomId: activeRoomId,
        transcriptId: candidate.entry.id,
        outcome: candidate.verdict.outcome,
        message: candidate.message,
      });
    }

    if (isTransmitting || voiceQueueRunningRef.current || voiceQueueRef.current.length === 0) return;
    voiceQueueRunningRef.current = true;
    void (async () => {
      try {
        while (voiceQueueRef.current.length > 0 && !isTransmittingRef.current && !sessionEnded) {
          const next = voiceQueueRef.current.shift();
          if (!next || next.roomId !== activeRoomId) continue;
          verificationTrace('voice feedback requested', {
            roomId: next.roomId,
            transcriptId: next.transcriptId,
            verdict: next.outcome,
          });
          await speakSafeCommVerification(next.outcome, next.message, availableVoices);
        }
      } finally {
        voiceQueueRunningRef.current = false;
      }
    })();
  }, [
    verificationCandidates,
    isTransmitting,
    availableVoices,
    sessionEnded,
    activeRoomId,
  ]);

  useEffect(() => () => {
    pendingReadbackTimersRef.current.forEach((timer) => clearTimeout(timer));
    pendingReadbackTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (isTransmitting) cancelAllSpeech();
  }, [isTransmitting]);

  // --------------------------------------------------------------------------
  // Persist transmission, instructions, verdict, and alerts to Supabase
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (currentRole !== 'pilot' || sessionEnded || !canonicalRoomId) return;

    for (const candidate of verificationCandidates) {
      const dedupeKey = `${canonicalRoomId}_${candidate.entry.id}_${candidate.controllerEntry?.id || 'unpaired'}_${candidate.verdict.outcome}`;
      if (syncedVerdictsRef.current.has(dedupeKey)) continue;
      syncedVerdictsRef.current.add(dedupeKey);

      void (async () => {
        try {
          const { data: authData, error: authError } = await supabase.auth.getUser();
          if (authError) throw authError;
          if (!authData.user) throw new Error('No authenticated user available to persist the verdict.');

          const { error: sessionError } = await supabase.from('sessions').upsert({
              id: canonicalRoomId,
              user_id: authData.user.id,
              scenario_name: roomState?.room?.airport ? `${roomState.room.airport} Comm Session` : 'Aeronautical Comm Session',
              status: 'active',
            }, { onConflict: 'id' });
          if (sessionError) throw sessionError;

          const result = await syncTransmissionToSupabase(
            canonicalRoomId,
            'pilot',
            candidate.entry.text,
            candidate.entry.callsign || myCallsign,
            candidate.pilotExtraction.instructions,
            candidate.verdict,
            candidate.entry.id,
            candidate.message
          );
          if (!result.success) throw new Error(result.error || 'Supabase rejected verification persistence.');
          verificationTrace('persistence succeeded', {
            roomId: canonicalRoomId,
            transcriptId: candidate.entry.id,
            verdict: candidate.verdict.outcome,
            verdictId: result.verdictId || undefined,
            alertId: result.alertId || undefined,
          });
        } catch (err) {
          console.error('[SafeComm/Sentinel] Error persisting verdict:', err);
          verificationTrace('persistence failed', {
            roomId: canonicalRoomId,
            transcriptId: candidate.entry.id,
            verdict: candidate.verdict.outcome,
          });
          setPersistenceError('This verification is visible locally but could not be saved to the safety ledger.');
        }
      })();
    }
  }, [
    verificationCandidates,
    currentRole,
    sessionEnded,
    canonicalRoomId,
    myCallsign,
    roomState?.room?.airport,
  ]);

  const handleReplayAdvisory = () => {
    if (activeVerdict && latestPilotExtraction && !isVerificationPending) {
      void speakSafeCommVerification(
        activeVerdict.outcome,
        activeVerificationMessage,
        availableVoices
      );
    }
  };

  // Loading State
  if (loading) {
    return (
      <div className="comm-session-container">
        <div className="comm-workspace-panel" style={{ minHeight: '360px', alignItems: 'center', justifyContent: 'center' }}>
          <Loader2 size={28} className="animate-spin" color="#0071E3" />
          <div style={{ marginTop: 14, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
            Establishing SafeComm Aeronautical Frequency...
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            Synchronizing room transceivers and station telemetry
          </div>
        </div>
      </div>
    );
  }

  // Error State (Invalid/Missing Room)
  if (errorMessage && !roomState) {
    return (
      <div className="comm-session-container">
        <div className="comm-workspace-panel" style={{ minHeight: '360px', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 16 }}>
          <AlertTriangle size={36} color="#FF9F0A" />
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            Communication Channel Unavailable
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 440, lineHeight: 1.45 }}>
            {errorMessage}
          </div>
          <button type="button" className="comm-btn-return-dashboard" onClick={handleReturnDashboard} style={{ maxWidth: 220 }}>
            <ArrowLeft size={14} />
            <span>Return to Dashboard</span>
          </button>
        </div>
      </div>
    );
  }

  const room = roomState?.room;
  const isLive = room?.status === 'active' && !sessionEnded;
  const peerTransmitting = peerAudio.isTransmitting;
  const peerRoleLabel = currentRole === 'atc' ? 'Cockpit (Flight Crew)' : 'Tower (Air Traffic Control)';

  return (
    <div className="comm-session-container">
      {visualSafetyAlert?.roomId === activeRoomId && (
        <div
          className={`comm-safety-toast ${visualSafetyAlert.outcome.toLowerCase()}`}
              role={visualSafetyAlert.outcome === 'MISMATCH' ? 'alert' : 'status'}
              aria-live={visualSafetyAlert.outcome === 'MISMATCH' ? 'assertive' : 'polite'}
        >
          <span className="comm-safety-toast-icon" aria-hidden="true">
            {visualSafetyAlert.outcome === 'MATCH'
              ? <CheckCircle2 size={17} />
              : <AlertTriangle size={17} />}
          </span>
          <span className="comm-safety-toast-message">{visualSafetyAlert.message}</span>
          <button
            type="button"
            className="comm-safety-toast-dismiss"
            onClick={() => setVisualSafetyAlert(null)}
            aria-label="Dismiss safety notification"
          >
            ×
          </button>
        </div>
      )}
      {/* --------------------------------------------------------------------------
          1. Dedicated Session Header Bar
          -------------------------------------------------------------------------- */}
      <section className="comm-session-header-bar" aria-label="Aeronautical Frequency Header">
        <div className="comm-session-header-left">
          <div className="comm-channel-icon-pill">
            <Radio size={19} />
          </div>
          <div className="comm-session-titles">
            <div className="comm-session-headline">
              <span className="comm-session-name">SafeComm Operational Frequency</span>
              <div className="comm-session-code-chip" title="Click to copy room code">
                <span>{room?.join_code || 'SFC-COMM'}</span>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  style={{ border: 'none', background: 'none', padding: 0, display: 'inline-flex', cursor: 'pointer' }}
                  aria-label="Copy Room Code"
                >
                  {copiedCode ? <Check size={13} color="#107C41" /> : <Copy size={13} className="comm-session-copy-icon" />}
                </button>
              </div>
            </div>
            <div className="comm-session-subheadline">
              <span>{room?.airport || 'KSFO'} San Francisco Tower</span>
              <span>·</span>
              <span>{room?.frequency || '120.500 MHz'}</span>
              <span>·</span>
              <span>{zuluTime}</span>
            </div>
          </div>
        </div>

        <div className="comm-session-header-right">
          {/* Status Badge */}
          <span
            className={`comm-session-status-pill ${
              isLive ? 'live' : sessionEnded ? 'ended' : 'waiting'
            }`}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: 'currentColor',
                display: 'inline-block',
              }}
            />
            {isLive
              ? '● LIVE OPERATIONAL CHANNEL'
              : sessionEnded
              ? 'SESSION CONCLUDED'
              : 'WAITING FOR PARTICIPANT'}
          </span>

          {/* Session Duration Timer */}
          <div className="comm-session-timer" title="Elapsed Transmission Time">
            <Clock size={13} />
            <span>{formatElapsed(elapsedSeconds)}</span>
          </div>

          {/* End Comm Action Button */}
          {!sessionEnded ? (
            <button
              type="button"
              className="comm-btn-end"
              onClick={handleEndComm}
              disabled={isEnding}
              title="Conclude communication room session for both stations"
              aria-label="End Comm"
            >
              {isEnding ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  <span>Concluding...</span>
                </>
              ) : (
                <>
                  <LogOut size={13} />
                  <span>End Comm</span>
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              className="comm-btn-end"
              style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)', borderColor: 'var(--border-medium)' }}
              onClick={handleReturnDashboard}
            >
              <ArrowLeft size={13} />
              <span>Return to Dashboard</span>
            </button>
          )}
        </div>
      </section>

      {/* --------------------------------------------------------------------------
          2. Participants Panel (Dual Station Station)
          -------------------------------------------------------------------------- */}
      <section className="comm-participants-panel" aria-label="Station Transceiver Telemetry">
        {/* Station 1: Air Traffic Control (ATC Officer) */}
        <div className={`comm-station-box ${currentRole === 'atc' ? 'current-user' : ''}`}>
          <div className="comm-station-box-header">
            <div className="comm-station-identity">
              <div className="comm-station-avatar atc">
                <TowerControl size={15} />
              </div>
              <span className="comm-station-role-label">Air Traffic Control</span>
            </div>
            {currentRole === 'atc' && <span className="comm-station-you-badge">You</span>}
          </div>

          <div className="comm-station-callsign-row">
            <span className="comm-station-callsign-text">
              {atcParticipant?.callsign || 'KSFO Tower Lead'}
            </span>
            <span className="comm-station-telemetry-tag">Ground & Tower Sector</span>
          </div>

          <div className="comm-station-connection-footer">
            <div className="comm-presence-indicator">
              <span className={`comm-presence-beacon-dot ${isAtcOnline ? 'online' : 'waiting'}`} />
              <span>{isAtcOnline ? 'Station Online (Low Latency)' : 'Station Reconnecting...'}</span>
            </div>
            <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {currentRole === 'atc' && isTransmitting ? 'TX ACTIVE' : 'TX Standby'}
            </span>
          </div>
        </div>

        {/* Station 2: Flight Crew (Pilot in Command) */}
        <div className={`comm-station-box ${currentRole === 'pilot' ? 'current-user' : ''}`}>
          <div className="comm-station-box-header">
            <div className="comm-station-identity">
              <div className="comm-station-avatar pilot">
                <Plane size={15} />
              </div>
              <span className="comm-station-role-label">Flight Crew (Pilot)</span>
            </div>
            {currentRole === 'pilot' && <span className="comm-station-you-badge">You</span>}
          </div>

          <div className="comm-station-callsign-row">
            <span
              className="comm-station-callsign-text"
              style={{
                color: pilotParticipant ? 'var(--text-primary)' : 'var(--text-tertiary)',
                fontStyle: pilotParticipant ? 'normal' : 'italic',
              }}
            >
              {pilotParticipant?.callsign || 'Awaiting Pilot Check-in...'}
            </span>
            <span className="comm-station-telemetry-tag">Cockpit Readback Station</span>
          </div>

          <div className="comm-station-connection-footer">
            <div className="comm-presence-indicator">
              <span
                className={`comm-presence-beacon-dot ${
                  isPilotOnline ? 'online' : pilotParticipant ? 'waiting' : 'offline'
                }`}
              />
              <span>
                {isPilotOnline
                  ? 'Transponder Linked (Cockpit Online)'
                  : pilotParticipant
                  ? 'Standby on Frequency...'
                  : 'Awaiting Transponder Link...'}
              </span>
            </div>
            <span style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {currentRole === 'pilot' && isTransmitting ? 'TX ACTIVE' : 'RX Standby'}
            </span>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------------------
          3. Live Communication Workspace (Aviation Transceiver + Transcript + Sentinel)
          -------------------------------------------------------------------------- */}
      <section className="comm-workspace-grid" aria-label="Aeronautical Communication Workspace">
        {/* Full-Width Audio Transceiver Interface Stage */}
        <div className="comm-workspace-panel full-width">
          <div className="comm-panel-header">
            <div className="comm-panel-title-group">
              <div className="comm-panel-title">
                <Radio size={15} color="#0071E3" />
                <span>Aeronautical Voice Transceiver</span>
              </div>
              <div className="comm-panel-desc">
                Live bidirectional Agora RTC radio frequency link with microphone speech recognition
              </div>
            </div>
            <span className="comm-panel-badge">{room?.frequency || '120.500 MHz'}</span>
          </div>

          <div className="comm-transceiver-stage">
            {/* Status Chips Row */}
            <div className="comm-audio-status-row">
              <span
                className={`comm-audio-status-chip ${
                  audioStatus === 'connected' && hasRemoteTrack && !isAudioBlocked
                    ? 'connected'
                    : audioStatus === 'connected' && !hasRemoteTrack
                    ? 'standby'
                    : audioStatus === 'audio_blocked' || isAudioBlocked
                    ? 'audio_blocked'
                    : audioStatus === 'mic_blocked'
                    ? 'mic_blocked'
                    : audioStatus === 'no_mic'
                    ? 'no_mic'
                    : audioStatus === 'reconnecting'
                    ? 'reconnecting'
                    : 'connecting'
                }`}
                title={statusMessage}
                onClick={isAudioBlocked ? handleEnableAudio : undefined}
                style={{ cursor: isAudioBlocked ? 'pointer' : 'default' }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'currentColor',
                    display: 'inline-block',
                  }}
                />
                {audioStatus === 'connected' && hasRemoteTrack && !isAudioBlocked
                  ? '● AGORA RADIO LINK ACTIVE'
                  : audioStatus === 'connected' && !hasRemoteTrack
                  ? '● FREQUENCY LINKED · STANDBY FOR PEER AUDIO'
                  : audioStatus === 'audio_blocked' || isAudioBlocked
                  ? '● AUDIO BLOCKED (TAP TO HEAR)'
                  : audioStatus === 'connecting'
                  ? '● CONNECTING AGORA RADIO...'
                  : audioStatus === 'mic_blocked'
                  ? '● MICROPHONE BLOCKED'
                  : audioStatus === 'no_mic'
                  ? '● NO MICROPHONE FOUND'
                  : audioStatus === 'reconnecting'
                  ? '● RECONNECTING AUDIO LINK...'
                  : '● RADIO STANDBY'}
              </span>

              {/* Speech Recognition / ASR Status Indicator */}
              {speechStatus === 'unsupported' ? (
                <span className="comm-audio-status-chip standby" title="Speech recognition is unavailable in this browser. Typed transmissions can still be verified; spoken transmissions cannot.">
                  <FileText size={11} />
                  <span>ASR STANDBY (MANUAL TX)</span>
                </span>
              ) : speechStatus === 'hosted_transcribing' ? (
                <span className="comm-audio-status-chip connected" title="Browser recognition failed; the captured PTT audio is being sent to Groq for transcription.">
                  <Mic size={11} />
                  <span>ASR TRANSCRIBING</span>
                </span>
              ) : speechStatus === 'hosted_error' ? (
                <span className="comm-audio-status-chip mic_blocked" title="Hosted speech transcription failed. Check the transcription service configuration and retry PTT.">
                  <MicOff size={11} />
                  <span>ASR TRANSCRIPTION ERROR</span>
                </span>
              ) : speechStatus === 'network_error' ? (
                <span className="comm-audio-status-chip mic_blocked" title="The browser speech-recognition service could not be reached. On PTT release, the captured audio will be sent to Groq for transcription.">
                  <MicOff size={11} />
                  <span>ASR NETWORK ERROR</span>
                </span>
              ) : speechStatus === 'error' ? (
                <span className="comm-audio-status-chip mic_blocked" title="Speech recognition error or permission blocked">
                  <MicOff size={11} />
                  <span>ASR UNAVAILABLE</span>
                </span>
              ) : speechStatus === 'idle' ? (
                <span className="comm-audio-status-chip standby" title="Speech recognition engine standby">
                  <Mic size={11} />
                  <span>ASR STANDBY</span>
                </span>
              ) : isTransmitting ? (
                <span className="comm-audio-status-chip connected" title="Capturing speech from your microphone">
                  <Mic size={11} />
                  <span>TX RECOGNIZING</span>
                </span>
              ) : (
                <span className="comm-audio-status-chip connected" title="Speech recognition engine listening and ready">
                  <Mic size={11} />
                  <span>ASR LISTENING</span>
                </span>
              )}

              {isMuted && (
                <span className="comm-audio-status-chip mic_blocked">
                  <MicOff size={11} />
                  <span>MIC MUTED</span>
                </span>
              )}

              {isPTTLocked && (
                <span className="comm-audio-status-chip connected">
                  <Lock size={11} />
                  <span>OPEN FREQ (LOCKED)</span>
                </span>
              )}
            </div>

            {/* Audio Blocked Alert Banner with Explicit Enable Action */}
            {(isAudioBlocked || audioStatus === 'audio_blocked') && (
              <div className="comm-audio-blocked-banner" role="alert">
                <div className="comm-audio-blocked-info">
                  <VolumeX size={16} />
                  <span>Incoming radio audio is paused by browser autoplay policy</span>
                </div>
                <button
                  type="button"
                  className="comm-btn-enable-audio"
                  onClick={handleEnableAudio}
                  title="Enable audio playback from peer station"
                >
                  <Volume2 size={13} />
                  <span>Enable Audio / Tap to Hear</span>
                </button>
              </div>
            )}

            {/* Remote Peer Transmitting Banner (Truthful Model: Real Audio vs Radio Signaling) */}
            {isRemoteAudioActive && hasRemoteTrack ? (
              <div className="comm-remote-rx-banner">
                <Volume2 size={14} />
                <span>RX ACTIVE: Receiving spoken transmission from {peerRoleLabel}...</span>
              </div>
            ) : peerTransmitting ? (
              <div className="comm-remote-rx-banner" style={{ opacity: 0.85, background: 'rgba(0, 113, 227, 0.08)', borderColor: 'rgba(0, 113, 227, 0.25)' }}>
                <Radio size={14} color="#0071E3" />
                <span>RADIO SIGNAL: {peerRoleLabel} transmitting...</span>
              </div>
            ) : null}

            {/* Transceiver Radar Circle */}
            <div
              className={`comm-transceiver-radar-circle ${
                isTransmitting ? 'tx' : isRemoteAudioActive ? 'rx' : isMuted ? 'muted' : ''
              }`}
            >
              {isMuted ? (
                <MicOff size={28} />
              ) : isTransmitting ? (
                <Radio size={28} color="#0071E3" />
              ) : (
                <Mic size={28} />
              )}
            </div>

            {/* Transceiver Controls Cluster */}
            <div className="comm-transceiver-controls-cluster">
              {/* Push-To-Talk Button */}
              <button
                type="button"
                className={`comm-ptt-button ${isTransmitting ? 'active' : ''}`}
                onPointerDown={(event) => {
                  if (!event.isPrimary || event.button !== 0) return;
                  handlePTTStart();
                  if (pttActiveRef.current && typeof event.currentTarget.setPointerCapture === 'function') {
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch (error) {
                      console.warn('[SafeComm/Audio] Could not capture the PTT pointer; release is still handled by pointer events.', error);
                    }
                  }
                }}
                onPointerUp={handlePTTEnd}
                onPointerCancel={handlePTTEnd}
                onLostPointerCapture={handlePTTEnd}
                disabled={!isLocalAudioReady || audioStatus === 'mic_blocked' || sessionEnded}
                title="Hold space or click and hold to transmit voice clearance"
              >
                <Mic size={16} />
                <span>
                  {isTransmitting
                    ? 'TRANSMITTING LIVE (TX ON)'
                    : 'PUSH-TO-TALK (HOLD TO SPEAK)'}
                </span>
              </button>

              {/* Mute / Unmute Button */}
              <button
                type="button"
                className={`comm-control-icon-btn ${isMuted ? 'muted' : ''}`}
                onClick={handleToggleMute}
                disabled={!isLocalAudioReady || audioStatus === 'mic_blocked' || sessionEnded}
                title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {isMuted ? <MicOff size={14} /> : <Mic size={14} />}
                <span>{isMuted ? 'Unmute Mic' : 'Mute Mic'}</span>
              </button>

              {/* Hands-Free / Lock Mic Toggle */}
              <button
                type="button"
                className={`comm-control-icon-btn ${isPTTLocked ? 'active' : ''}`}
                onClick={handleTogglePTTLock}
                disabled={!isLocalAudioReady || audioStatus === 'mic_blocked' || sessionEnded}
                title="Toggle continuous transmission (hands-free open mic)"
              >
                {isPTTLocked ? <Lock size={14} /> : <Unlock size={14} />}
                <span>{isPTTLocked ? 'Lock Active' : 'Lock Mic'}</span>
              </button>
            </div>

            {/* Live Interim Speech Bubble */}
            {interimSpeech && (
              <div className="comm-interim-speech-bubble">
                <Mic size={13} color="#0071E3" className="animate-pulse" />
                <span>
                  <strong>{isLocalInterim ? 'You' : peerRoleLabel}:</strong> "{interimSpeech}..."
                </span>
              </div>
            )}

            {/* Status Hint */}
            <div className="comm-transceiver-hint">
              {!isLocalAudioReady ? (
                <div role="status" style={{ color: audioStatus === 'connecting' || audioStatus === 'requesting_mic' ? 'var(--text-secondary)' : 'var(--accent-critical)' }}>
                  <span>{statusMessage}</span>
                  {audioStatus !== 'connecting' && audioStatus !== 'requesting_mic' && (
                    <button
                      type="button"
                      className="comm-btn-enable-audio"
                      onClick={() => void handleRetryVoice()}
                      disabled={isRetryingVoice}
                      title="Retry microphone and Agora voice connection"
                    >
                      {isRetryingVoice ? 'Retrying voice connection...' : 'Retry voice connection'}
                    </button>
                  )}
                </div>
              ) : audioStatus === 'mic_blocked' ? (
                <span style={{ color: 'var(--accent-critical)' }}>
                  Microphone access blocked. Please permit microphone access in your browser address bar to transmit radio audio.
                </span>
              ) : !isBrowserSpeechRecognitionSupported() ? (
                <span>
                  Agora audio streaming is active. (Web Speech API not supported in this browser; use manual dispatch below to record logs).
                </span>
              ) : (
                <span>
                  Tip: Hold <strong>Spacebar</strong> or the <strong>Push-To-Talk</strong> button to transmit audio. Spoken clearances are transcribed in real-time.
                </span>
              )}
            </div>

            {/* Manual Transmission Input (Station Role Locked) */}
            <form className="comm-manual-dispatch-form" onSubmit={handleManualDispatch}>
              <div
                className="comm-manual-role-locked"
                title={`Locked Station: ${currentRole === 'atc' ? 'Air Traffic Control' : 'Flight Crew'} (${myCallsign})`}
              >
                <span className={`comm-role-badge-locked ${currentRole}`}>
                  {currentRole === 'atc' ? 'ATC' : 'PILOT'}
                </span>
                <span className="comm-role-callsign-locked">{myCallsign}</span>
              </div>
              <input
                type="text"
                className="comm-manual-input"
                placeholder={
                  currentRole === 'atc'
                    ? 'Enter controller clearance (e.g. Speedbird 214, descend and maintain FL190)...'
                    : 'Enter flight crew readback (e.g. Descending FL190, Speedbird 214)...'
                }
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                disabled={sessionEnded}
              />
              <button
                type="submit"
                className="comm-btn-dispatch"
                disabled={!manualInput.trim() || sessionEnded}
                title={`Transmit clearance/readback as ${myCallsign}`}
              >
                <Send size={12} />
                <span>Transmit</span>
              </button>
            </form>
          </div>
        </div>

        {/* Left Panel: Live Transcript Stream */}
        <div className="comm-workspace-panel">
          <div className="comm-panel-header">
            <div className="comm-panel-title-group">
              <div className="comm-panel-title">
                <FileText size={15} />
                <span>Live Aeronautical Transcript Stream</span>
              </div>
              <div className="comm-panel-desc">
                Continuous speech-to-text transmission logs synchronized between stations
              </div>
            </div>
            <span className="comm-panel-badge">
              {transcripts.length} {transcripts.length === 1 ? 'TRANSMISSION' : 'TRANSMISSIONS'}
            </span>
          </div>

          {transcripts.length === 0 ? (
            <div className="comm-empty-state-box">
              <div className="comm-empty-icon-wrap">
                {audioStatus === 'mic_blocked' ? (
                  <MicOff size={20} color="var(--accent-critical)" />
                ) : speechStatus === 'unsupported' ? (
                  <FileText size={20} color="var(--text-secondary)" />
                ) : (
                  <Mic size={20} />
                )}
              </div>
              <div className="comm-empty-title">
                {audioStatus === 'mic_blocked'
                  ? 'Microphone Access Blocked'
                  : speechStatus === 'unsupported'
                  ? 'Voice Transcription Unsupported'
                  : 'Standby for Spoken Transmissions'}
              </div>
              <div className="comm-empty-desc">
                {audioStatus === 'mic_blocked'
                  ? 'Microphone permission was denied. Permit microphone access in your browser to transmit radio voice and generate automatic transcripts.'
                  : speechStatus === 'unsupported'
                  ? 'Speech-to-text recognition is not supported in this browser engine (e.g. Firefox/Safari). Use the manual dispatch field above to log transmissions.'
                  : 'Controller clearances and flight crew readbacks spoken via microphone or transmitted above will appear in chronological sequence.'}
              </div>
            </div>
          ) : (
            <div className="comm-transcript-stream-list" ref={transcriptListRef}>
              {transcripts.map((entry) => {
                const extraction = transcriptExtractions[entry.id];
                const isAtc = entry.role === 'atc';
                const verdict = !isAtc ? transmissionVerdicts[entry.id] : null;

                return (
                  <article
                    key={entry.id}
                    className={`comm-transcript-card ${isAtc ? 'is-atc' : 'is-pilot'}`}
                  >
                    <div className="comm-transcript-card-meta">
                      <span className={`comm-speaker-badge ${isAtc ? 'atc' : 'pilot'}`}>
                        {isAtc ? 'ATC CONTROLLER' : 'FLIGHT CREW'} · {entry.callsign}
                      </span>
                      <span className="comm-transcript-timestamp">{entry.timestamp}</span>
                    </div>

                    <div className="comm-transcript-text">{entry.text}</div>

                    {/* Extracted Parameters Tag Row */}
                    {!extraction ? (
                      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6 }}>
                        Extracting instruction fields…
                      </div>
                    ) : extraction.instructions.length > 0 && (
                      <div className="comm-transcript-params">
                        {extraction.instructions.map((inst, idx) => (
                          <span key={idx} className="comm-param-tag">
                            <span style={{ textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
                              {inst.type}{inst.direction ? ` ${inst.direction.toUpperCase()}` : ''}:
                            </span>
                            <strong>{inst.action ? `${inst.action.replace(/_/g, ' ')} ` : ''}{inst.value}</strong>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Inline Deterministic Readback Verdict Chip for Pilot transmissions */}
                    {verdict && (
                      <div
                        className={`comm-inline-verdict-tag ${verdict.outcome.toLowerCase()}`}
                        title={verdict.explanation}
                      >
                        {verdict.outcome === 'MATCH' ? (
                          <>
                            <CheckCircle2 size={12} color="#107C41" />
                            <span>READBACK VERIFIED</span>
                          </>
                        ) : verdict.outcome === 'MISMATCH' ? (
                          <>
                            <AlertTriangle size={12} color="#FF3B30" />
                            <span>DISCREPANCY ALERT: {verdict.mismatchedFields.join(', ')}</span>
                          </>
                        ) : verdict.outcome === 'PARTIAL' ? (
                          <>
                            <AlertTriangle size={12} color="#FF3B30" />
                            <span>UNVERIFIED: {verdict.omittedFields?.join(', ')}</span>
                          </>
                        ) : (
                          <span>UNVERIFIED</span>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Panel: Readback Verification & Safety Sentinel */}
        <div className="comm-workspace-panel">
          <div className="comm-panel-header">
            <div className="comm-panel-title-group">
              <div className="comm-panel-title">
                <ShieldCheck
                  size={15}
                  color={
                    activeVerdict?.outcome === 'MISMATCH'
                      ? '#FF3B30'
                      : activeVerdict?.outcome === 'PARTIAL'
                      ? '#FF9F0A'
                      : activeVerdict?.outcome === 'MATCH'
                      ? '#30D158'
                      : 'var(--text-secondary)'
                  }
                />
                <span>Readback Compliance & Safety Sentinel</span>
              </div>
              <div className="comm-panel-desc">
                Deterministic clearance vs readback parameter discrepancy detector
              </div>
            </div>
            <span className="comm-panel-badge">
              {isVerificationPending
                ? 'EXTRACTION PENDING'
                : activeVerdict
                ? activeVerdict.outcome === 'PARTIAL'
                  ? 'UNVERIFIED'
                  : activeVerdict.outcome === 'UNVERIFIED'
                    ? 'UNVERIFIED'
                    : 'MATCH VERIFIED'
                : 'Sentinel Active'}
            </span>
          </div>

          {!activeVerdict && !matchingAtcEntry ? (
            <div className="comm-empty-state-box">
              <div className="comm-empty-icon-wrap">
                <ShieldCheck size={20} color="#30D158" />
              </div>
              <div className="comm-empty-title">
                {isVerificationPending ? 'Interpreting Transmissions' : 'Safety Sentinel Armed'}
              </div>
              <div className="comm-empty-desc">
                {isVerificationPending
                  ? 'SafeComm is extracting transcript fields before issuing a verification result.'
                  : 'Awaiting spoken controller clearances and flight crew readbacks to perform deterministic phraseology analysis.'}
              </div>
            </div>
          ) : !activeVerdict && matchingAtcEntry ? (
            <div className="comm-sentinel-verdict-box partial">
              <div className="comm-sentinel-verdict-header">
                <span className="comm-sentinel-badge partial">AWAITING PILOT READBACK</span>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                  Aviation Safety Protocol
                </span>
              </div>
              <div className="comm-sentinel-explanation">
                Controller issued clearance: <strong>"{matchingAtcEntry.text}"</strong>. Standing by for flight crew transponder readback.
              </div>
            </div>
          ) : (
            <div className={`comm-sentinel-verdict-box ${activeVerdict!.outcome.toLowerCase()}`}>
              <div className="comm-sentinel-verdict-header">
                <span className={`comm-sentinel-badge ${activeVerdict!.outcome.toLowerCase()}`}>
                  {isVerificationPending
                    ? 'INTERPRETING TRANSMISSION'
                    : activeVerdict!.outcome === 'MATCH'
                    ? 'READBACK VERIFIED · COMPLIANT'
                    : activeVerdict!.outcome === 'MISMATCH'
                    ? 'DISCREPANCY ALERT · MISMATCH'
                    : activeVerdict!.outcome === 'PARTIAL'
                    ? 'UNVERIFIED · REQUIRED ITEMS MISSING'
                    : 'UNVERIFIED CLEARANCE'}
                </span>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                  Aviation Safety Protocol
                </span>
              </div>

              <div className="comm-sentinel-explanation">
                {isVerificationPending
                  ? 'SafeComm is interpreting the current room transcripts. No verdict has been issued yet.'
                  : activeVerificationMessage}
              </div>

              {/* Parameter Comparison Grid */}
              <div className="comm-sentinel-comp-grid">
                <div className="comm-comp-col">
                  <span className="comm-comp-label">ATC Assigned Clearances</span>
                  <span className="comm-comp-value">
                    {matchingAtcEntry
                      ? matchingAtcExtraction
                        ? matchingAtcExtraction.instructions.map(formatInstruction).join(', ')
                          || 'No explicit safety-critical fields extracted'
                        : 'Extracting ATC instruction…'
                      : latestAtcEntry
                        ? latestAtcExtraction
                          ? `No authoritative clearance paired. Latest ATC message: "${latestAtcEntry.text}"`
                          : 'Extracting latest ATC transmission…'
                        : 'None'}
                  </span>
                </div>
                <div className="comm-comp-col">
                  <span className="comm-comp-label">Flight Crew Readback</span>
                  <span className="comm-comp-value">
                    {latestPilotEntry
                      ? latestPilotExtraction
                        ? `${latestPilotExtraction.callsign !== 'UNKNOWN'
                            ? latestPilotExtraction.callsign
                            : latestPilotEntry.callsign}: ${latestPilotExtraction.instructions.map(formatInstruction).join(', ') || 'No explicit fields extracted'}`
                        : 'Extracting pilot readback…'
                      : 'None'}
                  </span>
                </div>
              </div>

              {!isVerificationPending && latestPilotExtraction && (
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  Extraction: ATC {describeExtraction(matchingAtcExtraction || latestAtcExtraction)} · Pilot {describeExtraction(latestPilotExtraction)} · deterministic comparison
                </div>
              )}
              {persistenceError && currentRole === 'pilot' && (
                <div role="alert" style={{ fontSize: 11, color: 'var(--accent-critical)', marginTop: 4 }}>
                  {persistenceError}
                </div>
              )}

              {/* Matched & Mismatched Parameter Highlights */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, marginTop: 4 }}>
                {activeVerdict!.matchedFields.length > 0 && (
                  <div style={{ color: '#107C41', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Check size={13} />
                    <span>Verified: {activeVerdict!.matchedFields.join(', ')}</span>
                  </div>
                )}
                {activeVerdict!.mismatchedFields.length > 0 && (
                  <div style={{ color: 'var(--accent-critical)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={13} />
                    <span>Discrepancy: {activeVerdict!.mismatchedFields.join(', ')}</span>
                  </div>
                )}
                {activeVerdict!.omittedFields && activeVerdict!.omittedFields.length > 0 && (
                  <div style={{ color: '#B45309', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <AlertTriangle size={13} />
                    <span>Omitted: {activeVerdict!.omittedFields.join(', ')}</span>
                  </div>
                )}
              </div>

              {/* Replay Voice Advisory Button */}
              {!isVerificationPending && (
                <button
                  type="button"
                  className="comm-btn-replay-voice"
                  onClick={handleReplayAdvisory}
                  title="Replay female SafeComm assistant spoken advisory"
                >
                  <Volume2 size={13} color="#0071E3" />
                  <span>Replay Verification Voice</span>
                </button>
              )}

              <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 4 }}>
                Simulated training advisory — SafeComm is not certified operational ATC equipment.
              </div>
            </div>
          )}
        </div>
      </section>

      {/* --------------------------------------------------------------------------
          Accidental Termination Confirmation Modal
          -------------------------------------------------------------------------- */}
      {showEndConfirm && (
        <div className="comm-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="comm-confirm-title">
          <div className="comm-confirm-card">
            <div className="comm-confirm-icon">
              <LogOut size={26} />
            </div>
            <div id="comm-confirm-title" className="comm-confirm-title">Conclude Communication Session?</div>
            <div className="comm-confirm-desc">
              Channel <strong>{room?.join_code || 'SFC-COMM'}</strong> on frequency <strong>{room?.frequency || '120.500 MHz'}</strong>.
              Ending the session will close live operational radio transceivers, speech recognition, and peer audio for both stations.
            </div>
            <div className="comm-confirm-actions">
              <button
                type="button"
                className="comm-btn-confirm-cancel"
                onClick={() => setShowEndConfirm(false)}
                disabled={isEnding}
              >
                Cancel
              </button>
              <button
                type="button"
                className="comm-btn-confirm-danger"
                onClick={executeEndComm}
                disabled={isEnding}
              >
                {isEnding ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    <span>Concluding...</span>
                  </>
                ) : (
                  <>
                    <LogOut size={13} />
                    <span>Confirm & End Comm</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------------
          Session Concluded Summary & 5-Star Rating Modal
          -------------------------------------------------------------------------- */}
      {sessionEnded && (
        <div className="comm-ended-overlay" role="dialog" aria-modal="true" aria-labelledby="comm-summary-title">
          <div className="comm-summary-modal-card">
            {/* Header */}
            <div className="comm-summary-header">
              <div className="comm-summary-header-icon">
                <CheckCircle2 size={24} />
              </div>
              <div>
                <div id="comm-summary-title" className="comm-summary-title">Aeronautical Session Concluded</div>
                <div className="comm-summary-sub">
                  Room <strong>{room?.join_code || 'SFC-COMM'}</strong> · {room?.airport || 'KSFO'} · {room?.frequency || '120.500 MHz'} · {formatElapsed(elapsedSeconds)} elapsed
                </div>
              </div>
            </div>

            {/* Stations row */}
            <div className="comm-summary-stations-row">
              <div className="comm-summary-station-item">
                <TowerControl size={14} color="#0071E3" />
                <span>ATC: <strong>{atcParticipant?.callsign || 'KSFO Tower'}</strong></span>
              </div>
              <div className="comm-summary-station-item">
                <Plane size={14} color="#30D158" />
                <span>Flight Crew: <strong>{pilotParticipant?.callsign || 'Speedbird 214'}</strong></span>
              </div>
              <div className="comm-summary-station-item">
                <Clock size={14} color="var(--text-secondary)" />
                <span>Duration: <strong>{formatElapsed(elapsedSeconds)}</strong></span>
              </div>
            </div>

            {/* Metrics 4-grid */}
            {transcripts.length > 0 ? (
              <div className="comm-summary-grid">
                <div className="comm-summary-stat-box">
                  <span className="comm-summary-stat-label">ATC Clearances</span>
                  <span className="comm-summary-stat-value">
                    {transcripts.filter((t) => t.role === 'atc').length}
                  </span>
                </div>
                <div className="comm-summary-stat-box">
                  <span className="comm-summary-stat-label">Pilot Readbacks</span>
                  <span className="comm-summary-stat-value">
                    {transcripts.filter((t) => t.role === 'pilot').length}
                  </span>
                </div>
                <div className="comm-summary-stat-box">
                  <span className="comm-summary-stat-label">Verified Compliant</span>
                  <span className="comm-summary-stat-value match">
                    {Object.values(transmissionVerdicts).filter((v) => v.outcome === 'MATCH').length}
                  </span>
                </div>
                <div className="comm-summary-stat-box">
                  <span className="comm-summary-stat-label">Discrepancies</span>
                  <span className="comm-summary-stat-value mismatch">
                    {Object.values(transmissionVerdicts).filter((v) => v.outcome === 'MISMATCH').length}
                  </span>
                </div>
              </div>
            ) : (
              <div className="comm-summary-empty">
                No radio transmissions or readbacks were recorded in this communication session.
              </div>
            )}

            {/* Star Rating Section */}
            <div className="comm-rating-section">
              <div className="comm-rating-title">Rate Communication & Verification Experience</div>
              <div className="comm-rating-subtitle">
                Provide training telemetry on readback detection clarity and simulation fidelity
              </div>

              {/* 5-Star Rating Buttons */}
              <div
                className="comm-stars-row"
                role="radiogroup"
                aria-label="Communication session rating (1 to 5 stars)"
              >
                {[1, 2, 3, 4, 5].map((star) => {
                  const isFilled = (hoverRating || rating) >= star;
                  return (
                    <button
                      key={star}
                      type="button"
                      role="radio"
                      aria-checked={rating === star}
                      aria-label={`${star} star${star > 1 ? 's' : ''}: ${starLabels[star]}`}
                      className={`comm-star-btn ${isFilled ? 'active' : ''}`}
                      onClick={() => !feedbackSubmitted && setRating(star)}
                      onMouseEnter={() => !feedbackSubmitted && setHoverRating(star)}
                      onMouseLeave={() => !feedbackSubmitted && setHoverRating(0)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          if (!feedbackSubmitted) setRating(star);
                        }
                      }}
                      disabled={feedbackSubmitted}
                    >
                      <Star
                        size={26}
                        fill={isFilled ? '#FF9F0A' : 'none'}
                        stroke={isFilled ? '#FF9F0A' : 'currentColor'}
                      />
                    </button>
                  );
                })}
              </div>

              {/* Dynamic Rating Label */}
              <div className="comm-star-feedback-label">
                {(hoverRating || rating) > 0 ? starLabels[hoverRating || rating] : 'Select 1–5 stars to rate session'}
              </div>

              {/* Feedback Textarea & Form */}
              {!feedbackSubmitted ? (
                <form onSubmit={handleSubmitFeedback} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <textarea
                    className="comm-feedback-textarea"
                    placeholder="Optional: Add readback observations, audio clarity notes, or simulation feedback..."
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value.slice(0, 500))}
                    maxLength={500}
                    disabled={isSubmittingFeedback}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {feedbackText.length}/500
                  </div>

                  {/* Error banner if submission failed */}
                  {feedbackError && (
                    <div className="comm-feedback-error-banner">
                      <span>{feedbackError}</span>
                      <button type="submit" className="comm-btn-retry-feedback">
                        Retry
                      </button>
                    </div>
                  )}

                  <div className="comm-feedback-actions-row">
                    <button
                      type="button"
                      className="comm-btn-skip-feedback"
                      onClick={handleReturnDashboard}
                      disabled={isSubmittingFeedback}
                    >
                      Skip
                    </button>
                    <button
                      type="submit"
                      className="comm-btn-submit-feedback"
                      disabled={rating === 0 || isSubmittingFeedback}
                    >
                      {isSubmittingFeedback ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          <span>Saving...</span>
                        </>
                      ) : (
                        <span>Submit Feedback</span>
                      )}
                    </button>
                  </div>
                </form>
              ) : (
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div className="comm-feedback-success-banner">
                    <CheckCircle2 size={16} />
                    <span>Feedback submitted. Thank you for contributing to SafeComm simulated aviation safety.</span>
                  </div>
                  <button
                    type="button"
                    className="comm-btn-return-dashboard"
                    onClick={handleReturnDashboard}
                  >
                    <ArrowLeft size={14} />
                    <span>Return to SafeComm Dashboard</span>
                  </button>
                </div>
              )}
            </div>

            {/* Bottom Skip / Return if not yet submitted and user wants to exit */}
            {!feedbackSubmitted && (
              <button
                type="button"
                className="comm-btn-return-dashboard"
                style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)', border: '1px solid var(--border-medium)' }}
                onClick={handleReturnDashboard}
              >
                <ArrowLeft size={14} />
                <span>Return to SafeComm Dashboard</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
