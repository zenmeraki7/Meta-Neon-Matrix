import React from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "s-page": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          title?: string;
          subtitle?: string;
          "back-action"?: string;
        },
        HTMLElement
      >;
      "s-section": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          heading?: string;
        },
        HTMLElement
      >;
      "s-card": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          title?: string;
        },
        HTMLElement
      >;
      "s-button": React.DetailedHTMLProps<
        React.ButtonHTMLAttributes<HTMLButtonElement> & {
          variant?: "primary" | "secondary" | "plain" | "tertiary";
          tone?: "critical" | "success";
          disabled?: boolean;
          url?: string;
        },
        HTMLButtonElement
      >;
      "s-text": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          variant?: "bodySm" | "bodyMd" | "bodyLg" | "headingSm" | "headingMd" | "headingLg";
          tone?: "subdued" | "critical" | "success" | "warning";
          as?: string;
        },
        HTMLElement
      >;
      "s-banner": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          tone?: "info" | "success" | "warning" | "critical";
          title?: string;
          "on-dismiss"?: () => void;
        },
        HTMLElement
      >;
      "s-badge": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          tone?: "info" | "success" | "warning" | "critical" | "subdued";
        },
        HTMLElement
      >;
      "s-box": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          padding?: string;
        },
        HTMLElement
      >;
    }
  }
}
