import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { AppShell } from './components/layout/AppShell';

import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Ledger } from './pages/Ledger';
import { RadarMap } from './pages/RadarMap';
import { Alerts } from './pages/Alerts';
import { Analytics } from './pages/Analytics';
import { Training } from './pages/Training';
import { Settings } from './pages/Settings';
import { CommSession } from './pages/CommSession';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />

          {/* Authenticated routes guarded by Supabase Auth and rendered inside AppShell */}
          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/comm/:roomId" element={<CommSession />} />
            <Route path="/comm" element={<CommSession />} />
            <Route path="/ledger" element={<Ledger />} />
            <Route path="/map" element={<RadarMap />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/training" element={<Training />} />
            <Route path="/settings" element={<Settings />} />
          </Route>

          {/* Fallback route */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
