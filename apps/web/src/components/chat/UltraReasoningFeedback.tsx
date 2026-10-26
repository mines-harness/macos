import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";

const UltraReasoningContext = createContext<((enabled?: boolean) => void) | null>(null);

export function useUltraReasoningFeedback() {
  return useContext(UltraReasoningContext);
}

export function UltraReasoningFeedback({
  children,
  onActivate,
}: {
  children: ReactNode;
  onActivate: (enabled?: boolean) => void;
}) {
  return <UltraReasoningContext value={onActivate}>{children}</UltraReasoningContext>;
}

function UltraReasoningSurfaceFeedback({ onComplete }: { readonly onComplete: () => void }) {
  const envelope = useRef<HTMLDivElement>(null);
  const aura = useRef<HTMLDivElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const sheen = useRef<HTMLDivElement>(null);
  const border = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const envelopeElement = envelope.current;
    const auraElement = aura.current;
    const glowElement = glow.current;
    const sheenElement = sheen.current;
    const borderElement = border.current;
    if (!envelopeElement || !auraElement || !glowElement || !sheenElement || !borderElement) {
      return;
    }

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const duration = 2400;
    let frame: number | null = null;
    let timer: number | undefined;
    let startedAt: number | undefined;
    const cancel = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      frame = null;
    };
    const showStatic = () => {
      cancel();
      envelopeElement.style.opacity = "0.65";
      auraElement.style.opacity = "0.55";
      auraElement.style.transform = "none";
      glowElement.style.opacity = "0.55";
      glowElement.style.transform = "none";
      sheenElement.style.opacity = "0";
      borderElement.style.opacity = "0";
      timer = window.setTimeout(onComplete, 1200);
    };
    const tick = (timestamp: number) => {
      frame = null;
      startedAt ??= timestamp;
      const elapsed = timestamp - startedAt;
      if (elapsed >= duration) {
        onComplete();
        return;
      }
      const progress = elapsed / duration;
      const pulse = (1 - Math.cos(progress * Math.PI * 4)) / 2;
      const opacity = Math.min(1, elapsed / 120, (duration - elapsed) / 550);
      const sweep = 1 - (1 - Math.min(1, elapsed / 1700)) ** 3;
      const translation = `translate3d(${(sweep * 2 - 1) * 100}%, 0, 0)`;

      envelopeElement.style.opacity = String(opacity);
      auraElement.style.opacity = String(0.3 + pulse * 0.6);
      auraElement.style.transform = `scale3d(${1 + pulse * 0.012}, ${1 + pulse * 0.012}, 1)`;
      glowElement.style.opacity = String(0.3 + pulse * 0.65);
      glowElement.style.transform = `scale3d(${1 + pulse * 0.018}, ${1 + pulse * 0.018}, 1)`;
      sheenElement.style.transform = translation;
      borderElement.style.transform = translation;
      frame = window.requestAnimationFrame(tick);
    };
    const handleMotionChange = () => {
      if (motion.matches) showStatic();
      else {
        cancel();
        onComplete();
      }
    };

    if (motion.matches) showStatic();
    else frame = window.requestAnimationFrame(tick);
    motion.addEventListener("change", handleMotionChange);
    return () => {
      cancel();
      motion.removeEventListener("change", handleMotionChange);
    };
  }, [onComplete]);

  return (
    <div
      ref={envelope}
      className="ultra-reasoning-feedback"
      data-testid="ultra-reasoning-feedback"
      aria-hidden="true"
    >
      <div ref={aura} className="ultra-reasoning-aura" />
      <div ref={glow} className="ultra-reasoning-glow" />
      <div className="ultra-reasoning-sheen">
        <div ref={sheen} className="ultra-reasoning-sheen-beam" />
      </div>
      <div className="ultra-reasoning-border">
        <div ref={border} className="ultra-reasoning-border-beam" />
      </div>
    </div>
  );
}

export function useUltraReasoningFeedbackState(selectionKey?: string) {
  const [state, setState] = useState({ selectionKey, activation: 0 });
  if (state.selectionKey !== selectionKey) setState({ selectionKey, activation: 0 });
  const activation = state.selectionKey === selectionKey ? state.activation : 0;
  const activate = (enabled = true) =>
    setState((state) => ({ selectionKey, activation: enabled ? state.activation + 1 : 0 }));
  const complete = useStableCallback(() => setState((state) => ({ ...state, activation: 0 })));
  const feedback = activation ? (
    <UltraReasoningSurfaceFeedback key={activation} onComplete={complete} />
  ) : null;
  return { activate, feedback };
}
