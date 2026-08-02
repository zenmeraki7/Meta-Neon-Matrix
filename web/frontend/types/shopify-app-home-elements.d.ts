import React from "react";

declare global {
  interface HTMLElementTagNameMap {
    "s-modal": HTMLElement & {
      showOverlay: () => void;
      hideOverlay: () => void;
    };
    "s-select": HTMLSelectElement;
    "s-text-field": HTMLInputElement;
    "s-checkbox": HTMLInputElement;
  }

  namespace JSX {
    interface IntrinsicElements {
      "s-page": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          heading?: string;
          subheading?: string;
          subtitle?: string;
          inlineSize?: string;
        },
        HTMLElement
      >;
      "s-section": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          heading?: string;
          padding?: string;
          accessibilityLabel?: string;
        },
        HTMLElement
      >;
      "s-button": React.DetailedHTMLProps<
        React.ButtonHTMLAttributes<HTMLButtonElement> & {
          variant?: "primary" | "secondary" | "plain" | "tertiary";
          tone?: "critical" | "success";
          disabled?: boolean;
          loading?: boolean;
          url?: string;
          href?: string;
          slot?: string;
          accessibilityLabel?: string;
          "aria-pressed"?: boolean;
          icon?: string;
          inlineSize?: string;
        },
        HTMLButtonElement
      >;
      "s-button-group": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          gap?: string;
        },
        HTMLElement
      >;
      "s-text": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          tone?: "subdued" | "critical" | "success" | "warning" | "neutral";
          color?: string;
          type?: string;
        },
        HTMLElement
      >;
      "s-paragraph": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          color?: string;
        },
        HTMLElement
      >;
      "s-heading": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-banner": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          tone?: "info" | "success" | "warning" | "critical";
          heading?: string;
          dismissible?: boolean;
          onDismiss?: () => void;
          "on-dismiss"?: () => void;
        },
        HTMLElement
      >;
      "s-badge": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          tone?: "info" | "success" | "warning" | "critical" | "subdued" | "neutral";
        },
        HTMLElement
      >;
      "s-box": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          padding?: string;
          paddingBlock?: string;
          border?: string;
          borderBlockEnd?: string;
          borderRadius?: string;
          background?: string;
          minBlockSize?: string;
          minInlineSize?: string;
          inlineSize?: string;
          maxInlineSize?: string;
        },
        HTMLElement
      >;
      "s-stack": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          gap?: string;
          direction?: string;
          alignItems?: string;
          justifyContent?: string;
          blockAlign?: string;
        },
        HTMLElement
      >;
      "s-grid": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          gridTemplateColumns?: string;
          gap?: string;
          alignItems?: string;
          justifyItems?: string;
          paddingBlock?: string;
          maxInlineSize?: string;
        },
        HTMLElement
      >;
      "s-icon": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          type?: string;
          size?: string;
          tone?: string;
          accessibilityLabel?: string;
        },
        HTMLElement
      >;
      "s-spinner": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          size?: string;
          accessibilityLabel?: string;
        },
        HTMLElement
      >;
      "s-divider": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-select": React.DetailedHTMLProps<
        React.SelectHTMLAttributes<HTMLSelectElement> & {
          label?: string;
          labelAccessibilityVisibility?: string;
          name?: string;
          details?: string;
          error?: string;
          required?: boolean;
        },
        HTMLSelectElement
      >;
      "s-option": React.DetailedHTMLProps<
        React.OptionHTMLAttributes<HTMLOptionElement> & {
          value?: string;
        },
        HTMLOptionElement
      >;
      "s-link": React.DetailedHTMLProps<
        React.AnchorHTMLAttributes<HTMLAnchorElement> & {
          slot?: string;
          href?: string;
        },
        HTMLAnchorElement
      >;
      "s-search-field": React.DetailedHTMLProps<
        React.InputHTMLAttributes<HTMLInputElement> & {
          label?: string;
          labelAccessibilityVisibility?: string;
          name?: string;
          placeholder?: string;
          value?: string;
          autocomplete?: string;
        },
        HTMLInputElement
      >;
      "s-table": React.DetailedHTMLProps<
        React.TableHTMLAttributes<HTMLTableElement> & {
          variant?: string;
          loading?: boolean;
          paginate?: boolean;
          hasNextPage?: boolean;
          hasPreviousPage?: boolean;
          onNextPage?: () => void;
          onPreviousPage?: () => void;
        },
        HTMLTableElement
      >;
      "s-table-header-row": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-table-header": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          listSlot?: string;
          format?: string;
        },
        HTMLElement
      >;
      "s-table-header-cell": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-table-body": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-table-row": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      "s-table-cell": React.DetailedHTMLProps<
        React.TdHTMLAttributes<HTMLTableCellElement>,
        HTMLTableCellElement
      >;
      "s-checkbox": React.DetailedHTMLProps<
        React.InputHTMLAttributes<HTMLInputElement> & {
          label?: string;
          checked?: boolean;
          disabled?: boolean;
          onChange?: (event: any) => void;
        },
        HTMLInputElement
      >;
      "s-text-field": React.DetailedHTMLProps<
        React.InputHTMLAttributes<HTMLInputElement> & {
          label?: string;
          name?: string;
          value?: string;
          placeholder?: string;
          disabled?: boolean;
          required?: boolean;
          error?: string;
          details?: string;
          onInput?: (event: any) => void;
          onChange?: (event: any) => void;
        },
        HTMLInputElement
      >;
      "s-modal": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          id?: string;
          heading?: string;
          accessibilityLabel?: string;
          size?: string;
          padding?: string;
          onHide?: () => void;
        },
        HTMLElement
      >;
    }
  }
}
