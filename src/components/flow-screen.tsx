import { useEffect, useRef, type ReactNode } from "react";

export function FlowScreen({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: "instant" }); }, [title]);
  return <section className="flow-enter mx-auto flex h-full min-h-0 w-full max-w-lg flex-col justify-center py-2" aria-labelledby="flow-heading">
    <p className="mb-2 text-xs font-medium uppercase tracking-[0.15em] text-primary">{eyebrow}</p>
    <h2 ref={heading} tabIndex={-1} id="flow-heading" className="mb-4 font-display text-2xl outline-none sm:text-3xl">{title}</h2>
    <div className="space-y-4">{children}</div>
  </section>;
}