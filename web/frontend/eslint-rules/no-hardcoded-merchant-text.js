const TECHNICAL_ATTRS = new Set([
  "className",
  "id",
  "key",
  "to",
  "href",
  "rel",
  "target",
  "type",
  "role",
  "src",
  "alt",
  "data-testid",
  "data-test-id",
  "aria-hidden",
]);

function hasLetters(value) {
  return /[A-Za-z]/.test(value);
}

function looksLikeI18nKey(value) {
  return /^[a-z0-9_.-]+$/.test(value) && value.includes(".");
}

function hasBadKeyTaxonomy(value) {
  return /\s/.test(value);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow hardcoded merchant-facing strings in JSX",
    },
    messages: {
      noHardcodedText:
        "Hardcoded merchant-facing text is not allowed in JSX. Use i18n keys via t(...).",
      noHardcodedProp:
        "Hardcoded merchant-facing string prop is not allowed. Use t(...) or translated constants.",
      invalidKeyTaxonomy:
        "Translation keys must not contain spaces. Use dotted taxonomy keys (for example, nav.spreadsheetEdit).",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXText(node) {
        const raw = node.value || "";
        const text = raw.trim();
        if (!text) return;
        if (!hasLetters(text)) return;
        context.report({ node, messageId: "noHardcodedText" });
      },
      JSXAttribute(node) {
        const attrName = node?.name?.name;
        if (!attrName || TECHNICAL_ATTRS.has(String(attrName))) return;
        if (String(attrName).startsWith("aria-")) return;

        const valueNode = node.value;
        if (!valueNode) return;

        if (valueNode.type === "Literal" && typeof valueNode.value === "string") {
          const value = valueNode.value.trim();
          if (!value || !hasLetters(value)) return;
          if (looksLikeI18nKey(value)) return;
          context.report({ node: valueNode, messageId: "noHardcodedProp" });
        }
      },
      CallExpression(node) {
        if (node?.callee?.type !== "Identifier" || node.callee.name !== "t") return;
        const arg0 = node.arguments?.[0];
        if (!arg0 || arg0.type !== "Literal" || typeof arg0.value !== "string") return;
        const value = arg0.value.trim();
        if (!value) return;
        if (hasBadKeyTaxonomy(value)) {
          context.report({ node: arg0, messageId: "invalidKeyTaxonomy" });
        }
      },
    };
  },
};
