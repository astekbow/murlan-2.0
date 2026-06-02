import { lazy, type ComponentType } from 'react';

/**
 * Like React.lazy, but retries the dynamic import once after a short delay before
 * failing. A transient network hiccup (or a CDN edge miss) on a code-split chunk
 * then recovers silently instead of bubbling to the error boundary. A persistent
 * failure (e.g. the chunk hash no longer exists after a deploy) still throws, and
 * the ErrorBoundary prompts a reload.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): ReturnType<typeof lazy<T>> {
  return lazy(() =>
    factory().catch(
      (err) =>
        new Promise<{ default: T }>((resolve, reject) => {
          setTimeout(() => {
            factory().then(resolve).catch(() => reject(err));
          }, 600);
        }),
    ),
  );
}
