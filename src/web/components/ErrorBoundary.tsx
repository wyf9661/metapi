import { Component, type ErrorInfo, type ReactNode } from 'react';
import { tr } from '../i18n.js';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Renders a slimmer card that fits inside a chart panel. */
  compact?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Renders a fallback card when a subtree throws — typically a lazy-loaded
 * chunk that never arrived (weak network) — instead of letting the error
 * unmount the whole app into a blank page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { compact } = this.props;
    return (
      <div
        className="card"
        style={{
          padding: compact ? 24 : 32,
          margin: compact ? undefined : '48px auto',
          maxWidth: compact ? undefined : 420,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{tr('加载失败')}</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('请检查网络后重试')}</div>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          {tr('重新加载')}
        </button>
      </div>
    );
  }
}
