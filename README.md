# SafeComm — AI-Powered Radio Read-Back Safety System

> **SafeComm is a real-time aerospace safety platform that monitors Air Traffic Control (ATC) and pilot radio exchanges, automatically verifying critical clearances against pilot read-backs to prevent runway incursions, altitude deviations, and heading conflicts before they manifest in flight.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Test Suite](https://img.shields.io/badge/Tests-193%20Passed-10b981.svg)](src/tests)
[![Aviation Compliance](https://img.shields.io/badge/Compliance-FAA%207110.65%20%2F%20ICAO%20Annex%2010-0ea5e9.svg)](src/lib/databaseSync.ts)

---

## 🌐 Live Deployments

- **Production Frontend:** [https://safecomm-aero.vercel.app](https://safecomm-aero.vercel.app) *(or your deployed Vercel/Netlify link)*
- **GitHub Repository:** [https://github.com/chethankp365/SafeComm](https://github.com/chethankp365/SafeComm)
- **Supabase Cloud Backend:** Managed PostgreSQL + Realtime + Edge Functions

---

## 📸 Screenshots & Operations Deck

| Live Radio Verification (`/dashboard`) | Terminal Radar Scope (`/map`) |
| :---: | :---: |
| ![Live Dashboard](https://raw.githubusercontent.com/chethankp365/SafeComm/main/docs/screenshots/dashboard.png) | ![Terminal Radar](https://raw.githubusercontent.com/chethankp365/SafeComm/main/docs/screenshots/radar.png) |

| Safety Alerts & Audit Log (`/alerts`) | Real-Time Telemetry Analytics (`/analytics`) |
| :---: | :---: |
| ![Safety Alerts](https://raw.githubusercontent.com/chethankp365/SafeComm/main/docs/screenshots/alerts.png) | ![Safety Analytics](https://raw.githubusercontent.com/chethankp365/SafeComm/main/docs/screenshots/analytics.png) |

| Pilot Mode Training Simulator (`/training`) | Immutable Clearance Ledger (`/ledger`) |
| :---: | :---: |
| ![Pilot Training](https://raw.githubusercontent.com/chethankp365/SafeComm/main/docs/screenshots/training.png) | ![Audit Ledger](https://raw.githubusercontent.com/chethankp365/SafeComm/main/docs/screenshots/ledger.png) |

---

## ⚖️ Honest Architecture: What is Simulated vs. What is Real

To maintain complete engineering integrity, here is an explicit, transparent breakdown of SafeComm's components:

| Component | Status | Operational Details |
| :--- | :--- | :--- |
| **Deterministic Verification Engine** | **100% REAL** | Implements FAA Order 7110.65 and ICAO Annex 10 standard phraseology rules. Tested across 193 rigorous unit tests with zero mock passes. Compares runway assignments, flight levels, headings, directions (left vs. right), speeds, and squawk codes. |
| **Cloud Database & Persistence** | **100% REAL** | Runs on live PostgreSQL (Supabase) with hardened Row-Level Security (RLS) policies, Realtime websockets, and database functions for `/ledger`, `/map`, `/alerts`, and `/analytics`. |
| **Safety Analytics & Metrics** | **100% REAL** | All metrics on `/analytics` (deviation rates, historical trend line charts via Recharts, outcome distribution donuts, and session logs) are dynamically aggregated from real Supabase rows — no fabricated numbers. |
| **Interactive Training Mode** | **100% REAL** | Graded live via the same deterministic comparison engine. Evaluates user-typed readbacks against controller clearances, tracks consecutive streaks in `localStorage`, and provides granular error breakdowns. |
| **Audio Voice Transport** | **100% REAL** | Integrated with Agora RTC Web SDK v4 for multi-user, low-latency push-to-talk (PTT) bidirectional communication between ATC and Pilot stations. |
| **Instruction Extraction (NLU)** | **HYBRID** | Dual-tier pipeline: primary server-side extraction via Supabase Edge Function (`Groq Llama 3.3 70B` / `Gemini 2.5 Flash`), with an instant sub-5ms deterministic rule-based local parser for offline reliability. |
| **Acoustic Radio Feed (ASR)** | **SIMULATED** | Scenario demonstrations feed transcripts from standard FAA ATC recordings (`src/data/scenarios.ts`) alongside Web Speech API recognition for live spoken input. |
| **Terminal Radar Target Positions** | **DERIVED** | In the absence of live ADS-B hardware transponders, aircraft blips on the Canvas radar display are positioned deterministically using callsign + session hash coordinate mapping. |

---

## 🛠️ Technology Stack

- **Frontend Core:** React 19, TypeScript 5.8, Vite 8, React Router v7
- **Styling & Aesthetics:** Apple-grade / Aerospace Glassmorphism (dark/light themes, HSL palettes, responsive canvas scopes)
- **Data Visualization:** Recharts 3.10 (Error Trend timelines, Outcome Distribution Donut charts)
- **Audio & Speech:** Agora RTC SDK v4 (voice channels), Web Audio API (Master Caution dual-tone earcons), Web Speech API
- **Backend & Cloud:** Supabase (PostgreSQL 15, Row-Level Security, Edge Functions, Realtime websockets)
- **Quality Assurance:** Vitest test suite (193 passing tests), Oxlint static analysis

---

## 🚀 Running Locally

### Prerequisites
- Node.js 18+ and `npm`
- Git

### 1. Clone & Install
```bash
git clone https://github.com/chethankp365/SafeComm.git
cd SafeComm
npm install
```

### 2. Configure Environment
Create a `.env` file in the root directory:
```env
VITE_SUPABASE_URL=https://sduigyfousbbhrgkjjjg.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 3. Launch Development Server
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 4. Run Test Suite & Build
```bash
# Run 193 unit tests
npm run test

# Compile production bundle
npm run build
```

---

## 🔒 Security & Secrets Hygiene

- **Zero Client Secrets:** Sensitive credentials (`AGORA_APP_CERTIFICATE`, `GROQ_API_KEY`, `GEMINI_API_KEY`, Supabase `service_role` keys) are exclusively kept in Supabase Edge Function secrets. Only public `anon` credentials are provided to the Vite frontend bundle.
- **Row-Level Security (RLS):** All table accesses (`sessions`, `transmissions`, `instructions`, `verdicts`, `alerts`, `comm_rooms`) are governed by hardened Postgres RLS policies and `SECURITY DEFINER` RPCs.

---

## 📜 Ethical Notice
> **PROTOTYPE — NOT FOR OPERATIONAL FLIGHT USE.** SafeComm is a software safety demonstrator built for aeronautical research, training simulators, and human-factors engineering. It is not certified by the FAA, EASA, or ICAO for active flight deck operations.
