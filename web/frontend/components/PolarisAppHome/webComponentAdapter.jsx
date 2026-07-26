import React, { useEffect, useRef } from "react";

/**
 * Normalizes event listeners and prop attributes for custom web-component elements (<s-*>)
 */
export function useCustomElementProps(props) {
  const elementRef = useRef(null);
  const { onClick, onDismiss, children, ...rest } = props;

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;

    if (onClick) {
      el.addEventListener("click", onClick);
    }
    if (onDismiss) {
      el.addEventListener("dismiss", onDismiss);
    }

    return () => {
      if (onClick) el.removeEventListener("click", onClick);
      if (onDismiss) el.removeEventListener("dismiss", onDismiss);
    };
  }, [onClick, onDismiss]);

  return { elementRef, children, rest };
}

export function SPage({ title, subtitle, backAction, children, ...props }) {
  const { elementRef } = useCustomElementProps(props);
  return (
    <s-page
      ref={elementRef}
      title={title}
      subtitle={subtitle}
      back-action={backAction}
      {...props}
    >
      {children}
    </s-page>
  );
}

export function SSection({ heading, children, ...props }) {
  const { elementRef } = useCustomElementProps(props);
  return (
    <s-section ref={elementRef} heading={heading} {...props}>
      {children}
    </s-section>
  );
}

export function SCard({ title, children, ...props }) {
  const { elementRef } = useCustomElementProps(props);
  return (
    <s-card ref={elementRef} title={title} {...props}>
      {children}
    </s-card>
  );
}

export function SButton({ variant, tone, disabled, onClick, children, ...props }) {
  const { elementRef } = useCustomElementProps({ onClick, ...props });
  return (
    <s-button
      ref={elementRef}
      variant={variant}
      tone={tone}
      disabled={disabled ? true : undefined}
      {...props}
    >
      {children}
    </s-button>
  );
}

export function SText({ variant, tone, as = "span", children, ...props }) {
  const { elementRef } = useCustomElementProps(props);
  return (
    <s-text ref={elementRef} variant={variant} tone={tone} as={as} {...props}>
      {children}
    </s-text>
  );
}

export function SBanner({ title, tone, onDismiss, children, ...props }) {
  const { elementRef } = useCustomElementProps({ onDismiss, ...props });
  return (
    <s-banner ref={elementRef} title={title} tone={tone} {...props}>
      {children}
    </s-banner>
  );
}

export function SBadge({ tone, children, ...props }) {
  const { elementRef } = useCustomElementProps(props);
  return (
    <s-badge ref={elementRef} tone={tone} {...props}>
      {children}
    </s-badge>
  );
}

export function SBox({ padding, children, ...props }) {
  const { elementRef } = useCustomElementProps(props);
  return (
    <s-box ref={elementRef} padding={padding} {...props}>
      {children}
    </s-box>
  );
}
