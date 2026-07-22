import React, { useState } from "react";
import type { ProxyLogRenderItem } from "./proxyLogsHelpers.js";
import { resolveProxyLogClientDisplay } from "./proxyLogsHelpers.js";

export const formInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 14px",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  outline: "none",
  background: "var(--color-bg)",
  color: "var(--color-text-primary)",
};

export const formSectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 14,
  border: "1px solid var(--color-border-light)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-bg-card)",
};

export const formSectionLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--color-text-secondary)",
  letterSpacing: "0.02em",
};

export const debugCheckboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "var(--color-text-primary)",
};

export const compactSummaryMetricStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  minWidth: 112,
};

export const debugCodeBlockStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  margin: 0,
  padding: 12,
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--color-border-light)",
  background: "var(--color-bg)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
  overflowX: "auto",
};

export const detailInfoGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 12,
};

export const detailInfoItemStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  minWidth: 0,
};

export const detailInfoLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--color-text-muted)",
};

export const detailInfoValueStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--color-text-primary)",
  fontWeight: 600,
  minWidth: 0,
  wordBreak: "break-word",
};

export const detailSectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--color-text-primary)",
};

export const detailExpandableCardStyle: React.CSSProperties = {
  border: "1px solid var(--color-border-light)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg-card)",
  overflow: "hidden",
};

export const detailExpandableSummaryStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  width: "100%",
  padding: "10px 12px",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--color-text-primary)",
  borderBottom: "1px solid var(--color-border-light)",
  background:
    "color-mix(in srgb, var(--color-bg-card) 86%, var(--color-bg) 14%)",
};

type DetailDisclosureCardProps = {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

export function DetailDisclosureCard({
  title,
  defaultOpen = false,
  children,
}: DetailDisclosureCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={detailExpandableCardStyle}>
      <button
        type="button"
        aria-label={`${open ? "收起" : "展开"}${title}`}
        style={{
          ...detailExpandableSummaryStyle,
          border: "none",
          cursor: "pointer",
        }}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{title}</span>
        <span
          style={{
            fontSize: 12,
            color: "var(--color-text-muted)",
            flexShrink: 0,
          }}
        >
          {open ? "收起" : "展开"}
        </span>
      </button>
      {open ? children : null}
    </div>
  );
}

export async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function renderProxyLogClientCell(
  log: Pick<
    ProxyLogRenderItem,
    "clientFamily" | "clientAppName" | "clientConfidence"
  >,
  options?: { includeGeneric?: boolean },
) {
  const display = resolveProxyLogClientDisplay(log, options);
  if (!display.primary) {
    return <span style={{ color: "var(--color-text-muted)" }}>-</span>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <span>{display.primary}</span>
        {display.heuristic ? (
          <span
            className="badge"
            style={{
              fontSize: 10,
              color: "var(--color-text-muted)",
              borderColor: "var(--color-border)",
            }}
          >
            推测
          </span>
        ) : null}
      </div>
      {display.secondary ? (
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          {display.secondary}
        </span>
      ) : null}
    </div>
  );
}

/** Compact stream/non-stream indicator for log tables. */
export function StreamModeIcon({
  isStream,
}: {
  isStream: boolean | null | undefined;
}) {
  if (isStream == null) {
    return (
      <span
        data-testid="proxy-log-stream-unknown"
        style={{ color: "var(--color-text-muted)", fontSize: 12 }}
      >
        -
      </span>
    );
  }

  if (isStream) {
    return (
      <span
        data-testid="proxy-log-stream-icon"
        title="流式"
        aria-label="流式"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-primary)",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 12c2.5-3 5.5-3 8 0s5.5 3 8 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M6.5 16.5c1.8-2.2 4-2.2 5.5 0s3.7 2.2 5.5 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M7.5 7.5c1.6-2 3.6-2 5 0s3.4 2 5 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </span>
    );
  }

  return (
    <span
      data-testid="proxy-log-nonstream-icon"
      title="非流"
      aria-label="非流"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-text-muted)",
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="5"
          y="4"
          width="14"
          height="16"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M8 9h8M8 13h8M8 17h5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function CompactSummaryMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div style={compactSummaryMetricStyle}>
      <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
        {label}
      </span>
      <strong
        style={{
          fontSize: 14,
          color: "var(--color-text-primary)",
          fontWeight: 700,
        }}
      >
        {value}
      </strong>
    </div>
  );
}
