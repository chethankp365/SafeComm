/**
 * SafeComm — Dedicated Transcript and Transmission Synchronization Service
 * 
 * Manages live spoken and manual transmissions independently of WebRTC audio.
 * Synchronizes transmissions across participants using Supabase Realtime broadcast,
 * local BroadcastChannel for cross-tab sessions, and localStorage persistence.
 */

import { supabase } from './supabase';
import type { CommRole } from './commRooms';
import { getZuluTimestamp } from './commAudio';
import { isValidExtractionResult, type ExtractionResult } from './llmExtractor';

export interface CommTranscriptEntry {
  id: string;
  roomId: string;
  role: CommRole;
  callsign: string;
  text: string;
  timestamp: string;
  isFinal: boolean;
  provisional?: boolean;
}

export interface SyncedReadbackVerdict {
  roomId: string;
  pilotTransmissionId: string;
  controllerTransmissionId: string | null;
  message: string;
  controllerExtraction: ExtractionResult | null;
  pilotExtraction: ExtractionResult;
  verdict: {
    outcome: 'MATCH' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED';
    severity: 'OK' | 'WARNING' | 'CRITICAL';
    explanation: string;
    matchedFields: string[];
    mismatchedFields: string[];
    omittedFields?: string[];
  };
}

function getTranscriptEpoch(id: string): number | null {
  const match = id.match(/-(\d{13})-[^-]+$/);
  return match ? Number(match[1]) : null;
}

function getTranscriptTimeOfDay(timestamp: string): number | null {
  const match = timestamp.match(/^(\d{2}):(\d{2}):(\d{2})\sUTC$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function compareTranscriptChronology(
  a: CommTranscriptEntry,
  b: CommTranscriptEntry
): number {
  const aEpoch = getTranscriptEpoch(a.id);
  const bEpoch = getTranscriptEpoch(b.id);
  if (aEpoch !== null && bEpoch !== null && aEpoch !== bEpoch) {
    return aEpoch - bEpoch;
  }

  const aTime = getTranscriptTimeOfDay(a.timestamp);
  const bTime = getTranscriptTimeOfDay(b.timestamp);
  if (aTime !== null && bTime !== null && aTime !== bTime) {
    return aTime - bTime;
  }

  return 0;
}

export interface TranscriptServiceCallbacks {
  onTranscript: (entry: CommTranscriptEntry) => void;
  onTranscriptsSync: (entries: CommTranscriptEntry[]) => void;
  onVerification?: (result: SyncedReadbackVerdict) => void;
  onError?: (error: string) => void;
}

interface TranscriptBroadcastPayload {
  roomId: string;
  fromClientId: string;
  fromRole: CommRole;
  type: 'transcript-entry' | 'transcripts-sync' | 'request-sync' | 'verification-result';
  transcript?: CommTranscriptEntry;
  transcripts?: CommTranscriptEntry[];
  verification?: SyncedReadbackVerdict;
}

export class TranscriptService {
  private roomId: string;
  private role: CommRole;
  private callsign: string;
  private callbacks: TranscriptServiceCallbacks;
  private clientId: string;

  private transcripts: CommTranscriptEntry[] = [];
  private seenIds = new Set<string>();

  private supabaseChannel: ReturnType<typeof supabase.channel> | null = null;
  private broadcastChannel: BroadcastChannel | null = null;
  private isSubscribed = false;
  private isCleanedUp = false;

  constructor(
    roomId: string,
    role: CommRole,
    callsign: string,
    callbacks: TranscriptServiceCallbacks
  ) {
    this.roomId = roomId;
    this.role = role;
    this.callsign = callsign;
    this.callbacks = callbacks;
    this.clientId = Math.random().toString(36).substring(2, 10);

    // 1. Recover any stored transcripts for this room from local storage
    this.loadFromStorage();
  }

  /**
   * Initializes Realtime broadcast channels and requests catch-up sync from peer
   */
  public initialize(): void {
    if (this.isCleanedUp) return;

    const channelName = `comm_transcripts_${this.roomId}`;

    // 1. Supabase Realtime Channel
    try {
      this.supabaseChannel = supabase
        .channel(channelName, {
          config: { broadcast: { ack: false } },
        })
        .on('broadcast', { event: 'transcript_event' }, ({ payload }) => {
          this.handleIncomingBroadcast(payload as TranscriptBroadcastPayload);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.isSubscribed = true;

            // Request sync from any online peer who has recorded transcripts
            this.broadcastPayload({
              roomId: this.roomId,
              fromClientId: this.clientId,
              fromRole: this.role,
              type: 'request-sync',
            });

            // If we have accumulated transcripts, share them with peers
            if (this.transcripts.length > 0) {
              this.broadcastPayload({
                roomId: this.roomId,
                fromClientId: this.clientId,
                fromRole: this.role,
                type: 'transcripts-sync',
                transcripts: this.transcripts,
              });
            }
          }
        });
    } catch (err) {
      this.callbacks.onError?.(`Failed to initialize transcript Realtime channel: ${err}`);
    }

    // 2. Local BroadcastChannel for instant same-browser cross-tab delivery
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.broadcastChannel = new BroadcastChannel(`safecomm_transcripts_${this.roomId}`);
        this.broadcastChannel.onmessage = (event) => {
          this.handleIncomingBroadcast(event.data as TranscriptBroadcastPayload);
        };

        // Announce and request sync locally
        this.broadcastChannel.postMessage({
          roomId: this.roomId,
          fromClientId: this.clientId,
          fromRole: this.role,
          type: 'request-sync',
        });
      }
    } catch {
      // ignore
    }

    // Notify caller with initial state
    this.callbacks.onTranscriptsSync([...this.transcripts]);
  }

  /**
   * Publishes a finalized spoken or manual transmission into the stream
   */
  public publishTransmission(text: string, provisional = false): CommTranscriptEntry | null {
    const cleanText = text.trim();
    if (!cleanText || this.isCleanedUp) return null;

    const entry: CommTranscriptEntry = {
      id: `${this.roomId}-${this.role}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      roomId: this.roomId,
      role: this.role,
      callsign: this.callsign,
      text: cleanText,
      timestamp: getZuluTimestamp(),
      isFinal: true,
      ...(provisional ? { provisional: true } : {}),
    };

    // Append locally
    this.appendEntry(entry);

    // Broadcast across both transport channels
    this.broadcastPayload({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'transcript-entry',
      transcript: entry,
    });

    return entry;
  }

  public publishVerification(result: SyncedReadbackVerdict): boolean {
    if (
      this.isCleanedUp ||
      !this.isSubscribed ||
      this.role !== 'pilot' ||
      result.roomId !== this.roomId
    ) return false;
    this.broadcastPayload({
      roomId: this.roomId,
      fromClientId: this.clientId,
      fromRole: this.role,
      type: 'verification-result',
      verification: result,
    });
    return true;
  }

  /**
   * Appends an entry, strictly deduplicating and persisting to storage
   */
  public appendEntry(entry: CommTranscriptEntry, senderRole?: CommRole): boolean {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.roomId !== 'string' ||
      entry.roomId !== this.roomId ||
      (entry.role !== 'atc' && entry.role !== 'pilot') ||
      (senderRole && entry.role !== senderRole) ||
      !entry.isFinal ||
      typeof entry.text !== 'string' ||
      !entry.text.trim() ||
      typeof entry.callsign !== 'string' ||
      typeof entry.timestamp !== 'string' ||
      this.seenIds.has(entry.id)
    ) {
      return false;
    }

    this.seenIds.add(entry.id);
    this.transcripts.push(entry);

    this.transcripts.sort(compareTranscriptChronology);
    this.saveToStorage();

    this.callbacks.onTranscript(entry);
    return true;
  }

  /**
   * Dispatches payloads across Supabase Realtime and BroadcastChannel
   */
  private broadcastPayload(payload: TranscriptBroadcastPayload): void {
    if (this.isCleanedUp) return;

    // 1. Supabase Realtime
    try {
      if (this.supabaseChannel && this.isSubscribed) {
        this.supabaseChannel.send({
          type: 'broadcast',
          event: 'transcript_event',
          payload,
        }).catch(() => {});
      }
    } catch {
      // ignore
    }

    // 2. Local BroadcastChannel
    try {
      if (this.broadcastChannel) {
        this.broadcastChannel.postMessage(payload);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Handles incoming broadcast messages from peers
   */
  private handleIncomingBroadcast(payload: TranscriptBroadcastPayload): void {
    if (!payload || payload.roomId !== this.roomId || this.isCleanedUp) return;
    // Ignore self-messages
    if (payload.fromClientId === this.clientId) return;

    switch (payload.type) {
      case 'transcript-entry': {
        if (payload.transcript && (payload.fromRole === 'atc' || payload.fromRole === 'pilot')) {
          this.appendEntry(payload.transcript, payload.fromRole);
        }
        break;
      }

      case 'transcripts-sync': {
        if (
          payload.transcripts &&
          Array.isArray(payload.transcripts) &&
          (payload.fromRole === 'atc' || payload.fromRole === 'pilot')
        ) {
          const originalCount = this.transcripts.length;
          payload.transcripts.forEach((item) => this.appendEntry(item, payload.fromRole));
          if (this.transcripts.length !== originalCount) {
            this.callbacks.onTranscriptsSync([...this.transcripts]);
          }
        }
        break;
      }

      case 'request-sync': {
        // Peer requested catch-up: send our transmissions
        if (this.transcripts.length > 0) {
          this.broadcastPayload({
            roomId: this.roomId,
            fromClientId: this.clientId,
            fromRole: this.role,
            type: 'transcripts-sync',
            transcripts: this.transcripts,
          });
        }
        break;
      }

      case 'verification-result': {
        const result = payload.verification;
        if (
          payload.fromRole === 'pilot' &&
          result?.roomId === this.roomId &&
          typeof result.pilotTransmissionId === 'string' &&
          typeof result.message === 'string' &&
          isValidExtractionResult(result.pilotExtraction) &&
          (result.controllerExtraction === null || isValidExtractionResult(result.controllerExtraction)) &&
          result.verdict &&
          ['MATCH', 'MISMATCH', 'PARTIAL', 'UNVERIFIED'].includes(result.verdict.outcome) &&
          ['OK', 'WARNING', 'CRITICAL'].includes(result.verdict.severity) &&
          typeof result.verdict.explanation === 'string' &&
          Array.isArray(result.verdict.matchedFields) &&
          Array.isArray(result.verdict.mismatchedFields)
        ) {
          this.callbacks.onVerification?.(result);
        }
        break;
      }
    }
  }

  /**
   * Local storage persistence helpers
   */
  private getStorageKey(): string {
    return `safecomm_transcripts_${this.roomId}`;
  }

  private loadFromStorage(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(this.getStorageKey());
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            this.transcripts = parsed.filter((entry): entry is CommTranscriptEntry =>
              Boolean(
                entry &&
                typeof entry.id === 'string' &&
                entry.id &&
                entry.roomId === this.roomId &&
                (entry.role === 'atc' || entry.role === 'pilot') &&
                typeof entry.callsign === 'string' &&
                typeof entry.text === 'string' &&
                entry.text.trim() &&
                typeof entry.timestamp === 'string' &&
                entry.isFinal === true
              )
            );
            this.transcripts.forEach((entry) => this.seenIds.add(entry.id));
          }
        }
      }
    } catch {
      // ignore storage parsing error
    }
  }

  private saveToStorage(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.getStorageKey(), JSON.stringify(this.transcripts));
      }
    } catch {
      // ignore storage write error
    }
  }

  public getTranscripts(): CommTranscriptEntry[] {
    return [...this.transcripts];
  }

  public setRole(role: CommRole): void {
    this.role = role;
  }

  public setCallsign(callsign: string): void {
    this.callsign = callsign;
  }

  public setRoomId(newRoomId: string): void {
    if (!newRoomId || this.roomId === newRoomId) return;
    this.roomId = newRoomId;
    if (this.supabaseChannel) {
      try {
        supabase.removeChannel(this.supabaseChannel);
      } catch {
        // ignore
      }
      this.supabaseChannel = null;
    }
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {
        // ignore
      }
      this.broadcastChannel = null;
    }
    this.isSubscribed = false;
    this.transcripts = [];
    this.seenIds.clear();
    this.loadFromStorage();
    this.initialize();
  }

  /**
   * Tears down Realtime and BroadcastChannel sockets
   */
  public cleanup(): void {
    this.isCleanedUp = true;
    if (this.supabaseChannel) {
      try {
        supabase.removeChannel(this.supabaseChannel);
      } catch {
        // ignore
      }
      this.supabaseChannel = null;
    }

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {
        // ignore
      }
      this.broadcastChannel = null;
    }
  }
}
