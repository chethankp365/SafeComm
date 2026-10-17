import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Construction } from 'lucide-react';

interface PlaceholderProps {
  title: string;
  badge: string;
  promptStep: string;
  description: string;
}

export const PlaceholderPage: React.FC<PlaceholderProps> = ({
  title,
  badge,
  promptStep,
  description,
}) => {
  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#FFFFFF',
      color: '#0A0A0A',
      display: 'flex',
      flexDirection: 'column',
      padding: '32px',
      fontFamily: 'var(--font-sans)',
    }}>
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: '24px',
        borderBottom: '1px solid rgba(0, 0, 0, 0.08)',
      }}>
        <Link to="/" style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '13px',
          color: '#52525B',
          fontWeight: 500,
        }}>
          <ArrowLeft size={16} />
          Back to SafeComm Home
        </Link>
        <span style={{
          fontSize: '11px',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          padding: '4px 10px',
          borderRadius: '9999px',
          backgroundColor: '#F4F4F6',
          color: '#71717A',
          fontWeight: 600,
        }}>
          {badge}
        </span>
      </header>

      <main style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        maxWidth: '540px',
        margin: '0 auto',
      }}>
        <div style={{
          width: '56px',
          height: '56px',
          borderRadius: '16px',
          backgroundColor: '#F4F4F6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '24px',
          border: '1px solid rgba(0, 0, 0, 0.08)',
        }}>
          <Construction size={24} color="#0A0A0A" />
        </div>
        <h1 style={{
          fontSize: '28px',
          fontWeight: 400,
          letterSpacing: '-0.02em',
          marginBottom: '12px',
        }}>
          {title}
        </h1>
        <p style={{
          fontSize: '14px',
          color: '#71717A',
          lineHeight: 1.6,
          marginBottom: '24px',
        }}>
          {description}
        </p>
        <div style={{
          padding: '8px 16px',
          borderRadius: '8px',
          backgroundColor: '#F8F9FA',
          border: '1px solid rgba(0, 0, 0, 0.08)',
          fontSize: '12px',
          color: '#52525B',
          fontFamily: 'monospace',
        }}>
          Scheduled for integration in {promptStep}
        </div>
      </main>
    </div>
  );
};
