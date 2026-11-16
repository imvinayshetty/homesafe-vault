import { useEffect, useRef, type ReactNode } from "react";

export function FlowScreen({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: "instant" }); }, [title]);
  return <section className="flow-enter mx-auto flex w-full max-w-lg flex-col py-6 sm:min-h-[calc(100svh-150px)] sm:justify-center sm:py-12" aria-labelledby="flow-heading">
    <p className="mb-4 text-xs font-medium uppercase tracking-[0.15em] text-primary">{eyebrow}</p>
    <h2 ref={heading} tabIndex={-1} id="flow-heading" className="mb-8 font-display text-3xl outline-none sm:text-4xl">{title}</h2>
    <div className="space-y-6">{children}</div>
  </section>;
}