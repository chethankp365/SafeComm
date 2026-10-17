import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isConfigured: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string) => Promise<{ error: Error | null; data?: { user: User | null; session: Session | null } }>;
  signInDemo: (email?: string) => Promise<{ error: Error | null }>;
  signInWithOAuth: (provider: 'google' | 'github') => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  createDatabaseSession: (scenarioName?: string) => Promise<{ id: string | null; error: Error | null }>;
}

const DEMO_USER_STORAGE_KEY = 'safecomm_demo_officer_session';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore demo user if stored in localStorage
  const restoreDemoUser = (): User | null => {
    try {
      const stored = localStorage.getItem(DEMO_USER_STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {
      // ignore
    }
    return null;
  };

  useEffect(() => {
    // Check initial Supabase session
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (session?.user) {
          setSession(session);
          setUser(session.user);
          localStorage.removeItem(DEMO_USER_STORAGE_KEY);
          setLoading(false);
        } else {
          // Check for stored demo session
          const demoUser = restoreDemoUser();
          if (demoUser) {
            setUser(demoUser);
          }
          setLoading(false);
        }
      })
      .catch((err) => {
        console.warn('[SafeComm] Error retrieving initial session:', err);
        const demoUser = restoreDemoUser();
        if (demoUser) setUser(demoUser);
        setLoading(false);
      });

    // Listen for Supabase auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setSession(session);
        setUser(session.user);
        localStorage.removeItem(DEMO_USER_STORAGE_KEY);
      }
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) return { error };
      if (data.session) {
        setSession(data.session);
        setUser(data.session.user);
        localStorage.removeItem(DEMO_USER_STORAGE_KEY);
      }
      return { error: null };
    } catch (err: unknown) {
      return { error: err as Error };
    }
  };

  const signUp = async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      });
      if (error) return { error };
      if (data.session) {
        setSession(data.session);
        setUser(data.session.user);
        localStorage.removeItem(DEMO_USER_STORAGE_KEY);
      }
      return { error: null, data: { user: data.user, session: data.session } };
    } catch (err: unknown) {
      return { error: err as Error };
    }
  };

  const signInDemo = async (demoEmail = 'officer@safecomm.aero'): Promise<{ error: Error | null }> => {
    try {
      // First attempt real Supabase sign-in with the pre-seeded account
      const { data, error } = await supabase.auth.signInWithPassword({
        email: demoEmail,
        password: 'Password123!',
      });

      if (data?.session && data?.user) {
        setSession(data.session);
        setUser(data.user);
        localStorage.removeItem(DEMO_USER_STORAGE_KEY);
        console.log('[SafeComm Auth] Real Supabase demo session active:', data.user.id);
        return { error: null };
      }

      // Fallback: set local demo user if user account not yet in Supabase
      const mockUser: User = {
        id: 'd3b07384-d113-494a-89a7-96a93bf81152',
        app_metadata: { provider: 'email' },
        user_metadata: { full_name: 'San Francisco Tower Controller 01', role: 'ATC Safety Officer' },
        aud: 'authenticated',
        created_at: new Date().toISOString(),
        email: demoEmail,
        phone: '',
        role: 'authenticated',
        updated_at: new Date().toISOString(),
      };
      setUser(mockUser);
      localStorage.setItem(DEMO_USER_STORAGE_KEY, JSON.stringify(mockUser));
      return { error: error || null };
    } catch (err) {
      return { error: err as Error };
    }
  };

  const signInWithOAuth = async (provider: 'google' | 'github') => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/dashboard`,
        },
      });
      return { error };
    } catch (err: unknown) {
      return { error: err as Error };
    }
  };

  const signOut = async () => {
    try {
      localStorage.removeItem(DEMO_USER_STORAGE_KEY);
      await supabase.auth.signOut();
    } catch (err) {
      console.error('[SafeComm] Sign out error:', err);
    } finally {
      setUser(null);
      setSession(null);
    }
  };

  const createDatabaseSession = async (scenarioName = 'Standard Tower Departure') => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      const currentAuthUser = authData?.user;

      const payload: { scenario_name: string; status: string; user_id?: string | null } = {
        scenario_name: scenarioName,
        status: 'active',
      };

      if (currentAuthUser) {
        payload.user_id = currentAuthUser.id;
      }

      const { data, error } = await supabase
        .from('sessions')
        .insert(payload)
        .select('id')
        .single();

      if (error) {
        console.error('[SafeComm Supabase Error] Failed to create database session:', error);
        return { id: null, error };
      }

      return { id: data.id, error: null };
    } catch (err: unknown) {
      console.error('[SafeComm Supabase Exception] createDatabaseSession:', err);
      return { id: null, error: err as Error };
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        isConfigured: isSupabaseConfigured,
        signIn,
        signUp,
        signInDemo,
        signInWithOAuth,
        signOut,
        createDatabaseSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
