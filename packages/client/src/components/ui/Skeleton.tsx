interface SkeletonProps {
  w?: string | number;
  h?: string | number;
  rounded?: string;
  className?: string;
}

/** A single shimmer block (reduced-motion safe via the universal rule). */
export function Skeleton({ w = '100%', h = 14, rounded = 'var(--r-sm)', className = '' }: SkeletonProps) {
  return <span className={`skeleton block ${className}`} style={{ width: w, height: h, borderRadius: rounded }} aria-hidden />;
}

/** A skeleton that mimics a ListItem row (avatar + two lines + a trailing pill). */
export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10">
      <Skeleton w={40} h={40} rounded="50%" />
      <div className="flex-1 space-y-2">
        <Skeleton w="55%" h={12} />
        <Skeleton w="35%" h={10} />
      </div>
      <Skeleton w={56} h={22} rounded="999px" />
    </div>
  );
}

/** A list of skeleton rows while data loads. */
export function SkeletonList({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-live="polite">
      {Array.from({ length: count }, (_, i) => <SkeletonRow key={i} />)}
    </div>
  );
}
