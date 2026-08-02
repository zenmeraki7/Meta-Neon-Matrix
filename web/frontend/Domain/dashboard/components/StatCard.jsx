function StatCard({
  icon,
  label,
  displayValue,
  url,
  actionLabel,
}) {
  const hasValue =
    typeof displayValue === "string" &&
    displayValue.trim().length > 0;

  return (
    <s-box
      background="base"
      border="base"
      borderRadius="base"
      padding="base"
    >
      <s-stack gap="base">
        <s-grid
          gridTemplateColumns="auto 1fr"
          gap="small-200"
          alignItems="center"
        >
          <s-icon type={icon} />

          <s-stack gap="small-200">
            <s-text color="subdued">
              {label}
            </s-text>

            {hasValue ? (
              <s-heading>{displayValue}</s-heading>
            ) : null}
          </s-stack>
        </s-grid>

        {url && actionLabel ? (
          <s-link href={url}>
            {actionLabel}
          </s-link>
        ) : null}
      </s-stack>
    </s-box>
  );
}

export default StatCard;