import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Link, useNavigate, useLocation, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Radio,
  ShieldAlert,
  ScrollText,
  Radar,
  BarChart3,
  GraduationCap,
  Settings,
  Search,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Clock,
  Moon,
  Sun,
  Info,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import './AppShell.css';

import { fetchUnreadAlertsCount } from '../../lib/alertsAnalyticsService';

export const AppShell: React.FC = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Dynamic Page Title
  useEffect(() => {
    const path = location.pathname;
    let title = 'SafeComm — AI-Powered Radio Read-Back Safety';
    if (path.startsWith('/dashboard')) title = 'Dashboard · SafeComm';
    else if (path.startsWith('/alerts')) title = 'Safety Alerts · SafeComm';
    else if (path.startsWith('/ledger')) title = 'Audit Ledger · SafeComm';
    else if (path.startsWith('/map')) title = 'Terminal Radar Scope · SafeComm';
    else if (path.startsWith('/analytics')) title = 'Safety Analytics · SafeComm';
    else if (path.startsWith('/training')) title = 'Pilot Training Simulator · SafeComm';
    else if (path.startsWith('/settings')) title = 'System Settings · SafeComm';
    else if (path.startsWith('/comm')) title = 'Comm Session · SafeComm';

    document.title = title;
  }, [location.pathname]);

  // Rail collapse state
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('safecomm_rail_collapsed') === 'true';
  });

  // User dropdown state
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Search input ref
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Live UTC Clock
  const [utcTime, setUtcTime] = useState<string>('');

  // Live Unread Alerts Count
  const [unreadAlertsCount, setUnreadAlertsCount] = useState<number>(0);

  // Dark mode state
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    return document.documentElement.classList.contains('dark') ||
      localStorage.getItem('safecomm_theme') === 'dark';
  });

  // Fetch unread count on mount and when alerts update
  useEffect(() => {
    let isMounted = true;
    const syncUnread = async () => {
      const count = await fetchUnreadAlertsCount();
      if (isMounted) {
        setUnreadAlertsCount(count);
      }
    };

    void syncUnread();

    const handleAlertsUpdate = () => {
      void syncUnread();
    };

    window.addEventListener('safecomm-alerts-updated', handleAlertsUpdate);
    const interval = setInterval(syncUnread, 12000);

    return () => {
      isMounted = false;
      window.removeEventListener('safecomm-alerts-updated', handleAlertsUpdate);
      clearInterval(interval);
    };
  }, []);

  // Update UTC clock every second
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = String(now.getUTCHours()).padStart(2, '0');
      const minutes = String(now.getUTCMinutes()).padStart(2, '0');
      const seconds = String(now.getUTCSeconds()).padStart(2, '0');
      setUtcTime(`${hours}:${minutes}:${seconds} UTC`);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Sync theme
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('safecomm_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('safecomm_theme', 'light');
    }
  }, [isDarkMode]);

  // Persist collapse state
  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('safecomm_rail_collapsed', String(next));
      return next;
    });
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcut Cmd+K / Ctrl+K to search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const navItems = [
    { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
    { label: 'Transcript', to: '/dashboard', icon: Radio },
    {
      label: 'Alerts',
      to: '/alerts',
      icon: ShieldAlert,
      badge: unreadAlertsCount > 0 ? String(unreadAlertsCount) : undefined,
    },
    { label: 'Ledger', to: '/ledger', icon: ScrollText },
    { label: 'Map', to: '/map', icon: Radar },
    { label: 'Analytics', to: '/analytics', icon: BarChart3 },
    { label: 'Training', to: '/training', icon: GraduationCap },
    { label: 'Settings', to: '/settings', icon: Settings },
  ];

  // User display initial
  const userEmail = user?.email || 'officer@safecomm.aero';
  const userInitial = userEmail.charAt(0).toUpperCase();

  return (
    <div className="app-shell">
      {/* Left Nav Rail */}
      <aside className={`app-nav-rail ${isCollapsed ? 'is-collapsed' : ''}`} aria-label="Main Navigation">
        <div className="nav-rail-header">
          <Link to="/dashboard" className="nav-brand-link" title="SafeComm Safety Console">
            <div className="nav-brand-icon">
              <img src="/src/assets/logo-icon.svg" alt="SafeComm" />
            </div>
            <div className="nav-brand-text">
              <span className="nav-brand-name">SafeComm</span>
              <span className="nav-brand-tag">Aerospace ASR/NLU</span>
            </div>
          </Link>
        </div>

        <nav className="nav-rail-menu">
          <div className="nav-section-label">Operations</div>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.label}
                to={item.to}
                end={item.to === '/dashboard'}
                className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}
                title={isCollapsed ? item.label : undefined}
              >
                <div className="nav-item-icon">
                  <Icon size={18} strokeWidth={2} />
                </div>
                <span className="nav-item-label">{item.label}</span>
                {item.badge && <span className="nav-item-badge">{item.badge}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="nav-rail-footer">
          <button
            type="button"
            className="nav-collapse-btn"
            onClick={toggleCollapse}
            title={isCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-label="Toggle rail collapse"
          >
            {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            <span className="nav-collapse-label">Collapse rail</span>
          </button>
        </div>
      </aside>

      {/* Main Layout Area */}
      <div className="app-main-layout">
        {/* Top Bar */}
        <header className="app-topbar">
          <div className="topbar-left">
            <div className="topbar-search-box">
              <Search size={15} className="topbar-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                className="topbar-search-input"
                placeholder="Search flights, callsigns, runways (e.g. UAL421)..."
                aria-label="Search flights and transmissions"
              />
              <span className="topbar-search-shortcut">⌘K</span>
            </div>
          </div>

          <div className="topbar-right">
            {/* Live ATC Status Chip */}
            <div className="atc-status-chip" title="Live Simulated Frequency Feed">
              <span className="atc-pulse-dot" />
              <span>ATC Tower</span>
              <span style={{ opacity: 0.4 }}>·</span>
              <span className="atc-freq">121.700 MHz</span>
            </div>

            {/* Live UTC Zulu Clock */}
            <div className="utc-clock-badge" title="Coordinated Universal Time (Zulu)">
              <Clock size={14} />
              <span>{utcTime || '00:00:00 UTC'}</span>
            </div>

            {/* Theme Toggle Button */}
            <button
              type="button"
              className="user-avatar-btn"
              onClick={() => setIsDarkMode(!isDarkMode)}
              title={isDarkMode ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
              style={{ padding: '6px 8px' }}
            >
              {isDarkMode ? <Sun size={15} /> : <Moon size={15} />}
            </button>

            {/* User Avatar & Menu */}
            <div className="user-menu-wrapper" ref={userMenuRef}>
              <button
                type="button"
                className="user-avatar-btn"
                onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                aria-expanded={isUserMenuOpen}
                title="User profile and settings"
              >
                <div className="user-avatar-circle">{userInitial}</div>
                <span className="user-avatar-email">{userEmail.split('@')[0]}</span>
              </button>

              {isUserMenuOpen && (
                <div className="user-dropdown-menu">
                  <div className="dropdown-user-header">
                    <div className="dropdown-user-name">{userEmail}</div>
                    <div className="dropdown-user-status">
                      <span className="atc-pulse-dot" style={{ width: 6, height: 6 }} />
                      <span>Authenticated Officer</span>
                    </div>
                  </div>

                  <Link
                    to="/settings"
                    className="dropdown-item"
                    onClick={() => setIsUserMenuOpen(false)}
                  >
                    <Settings size={14} />
                    <span>System Settings</span>
                  </Link>

                  <div className="dropdown-divider" />

                  <button
                    type="button"
                    className="dropdown-item is-danger"
                    onClick={handleSignOut}
                  >
                    <LogOut size={14} />
                    <span>Sign Out</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page Content Outlet */}
        <main className="app-content-body">
          <Outlet />
        </main>

        {/* Persistent Prototype Disclaimer Strip */}
        <footer className="app-prototype-disclaimer-strip" role="contentinfo">
          <span className="atc-pulse-dot" style={{ width: 6, height: 6, background: '#f59e0b' }} />
          <span>PROTOTYPE — NOT FOR OPERATIONAL USE · AERONAUTICAL SAFETY SYSTEM DEMONSTRATOR</span>
        </footer>
      </div>
    </div>
  );
};
