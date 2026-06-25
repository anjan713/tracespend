import { useEffect, useRef, useState } from 'react';

interface Props {
  value: number;
  /** format the (animated) numeric value into a string */
  format: (n: number) => string;
  durationMs?: number;
  reduceMotion?: boolean;
  className?: string;
}

/** Animated number roll-up using requestAnimationFrame. */
export default function CountUp({ value, format, durationMs = 900, reduceMotion, className }: Props) {
  // Start from 0 so the first paint animates up (cinematic entrance).
  const [display, setDisplay] = useState(reduceMotion ? value : 0);
  const fromRef = useRef(reduceMotion ? value : 0);
  const rafRef = useRef<number>();

  useEffect(() => {
    if (reduceMotion) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const from = fromRef.current;
    const to = value;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic
      const e = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * e);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs, reduceMotion]);

  return <span className={className}>{format(display)}</span>;
}
