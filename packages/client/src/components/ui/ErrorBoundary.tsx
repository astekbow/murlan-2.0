import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translate, useLangStore } from '../../lib/i18n.ts';

const tr = (key: string): string => translate(key, useLangStore.getState().lang);

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * App-wide error boundary. A render throw or a failed lazy() chunk import (common
 * after a deploy when an old chunk hash 404s, or on a flaky network) would
 * otherwise white-screen the whole app with no recovery. Here we show a friendly
 * Albanian fallback with a reload action instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep a console trace for diagnostics; a real telemetry sink can hook here.
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    // A failed dynamic import usually means the deployed chunks changed under a
    // long-lived tab — a hard reload fetches the new manifest.
    const isChunkError = /loading (css )?chunk|dynamically imported module|importing a module script failed/i.test(
      this.state.error.message,
    );

    return (
      <div className="min-h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-5xl">🃏</div>
        <h1 className="font-display text-xl tracking-wide text-gold-hi">{tr('errboundary.title')}</h1>
        <p className="text-sm text-muted max-w-xs">
          {isChunkError
            ? tr('errboundary.chunkBody')
            : tr('errboundary.genericBody')}
        </p>
        <button className="btn btn-gold" onClick={this.reload}>
          {tr('errboundary.reload')}
        </button>
      </div>
    );
  }
}
