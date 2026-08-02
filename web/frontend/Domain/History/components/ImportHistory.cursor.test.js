/* @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import ImportHistory from "./ImportHistory.tsx";

vi.mock("@shopify/polaris", () => {
  const wrap = (Tag = "div") => ({ children }) => React.createElement(Tag, null, children);
  return {
    Page: wrap("section"),
    Card: wrap("article"),
    Text: ({ children }) => React.createElement("span", null, children),
    BlockStack: wrap("div"),
    InlineStack: wrap("div"),
    Badge: ({ children }) => React.createElement("span", null, children),
    Button: ({ children, onClick }) =>
      React.createElement("button", { type: "button", onClick }, children),
    Spinner: () => React.createElement("div", null, "loading"),
    EmptyState: wrap("div"),
    DataTable: () => React.createElement("div", null, "table"),
    Box: wrap("div"),
    Icon: () => React.createElement("span", null, "icon"),
    useBreakpoints: () => ({ mdDown: false }),
    Pagination: ({ hasPrevious, hasNext, onPrevious, onNext }) =>
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          { type: "button", onClick: onPrevious, disabled: !hasPrevious, "data-testid": "prev-btn" },
          "Previous",
        ),
        React.createElement(
          "button",
          { type: "button", onClick: onNext, disabled: !hasNext, "data-testid": "next-btn" },
          "Next",
        ),
      ),
  };
});

vi.mock("@shopify/polaris-icons", () => ({
  CheckCircleIcon: {},
  AlertCircleIcon: {},
  ClockIcon: {},
  ViewIcon: {},
}));

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ImportHistory cursor pagination", () => {
  let container;
  let root;
  let fetchMock;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    fetchMock = vi.fn(async (url) => {
      const parsed = new URL(url, "http://localhost");
      const cursor = parsed.searchParams.get("cursor");

      if (!cursor) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: [{ id: "i1", filename: "one.csv", totalRows: 1, status: "completed", createdAt: new Date().toISOString() }],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          }),
        };
      }

      if (cursor === "c1") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: [{ id: "i2", filename: "two.csv", totalRows: 2, status: "completed", createdAt: new Date().toISOString() }],
            pageInfo: { hasNextPage: false, endCursor: "c2" },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ success: true, data: [], pageInfo: { hasNextPage: false, endCursor: null } }),
      };
    });

    global.fetch = fetchMock;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
    vi.restoreAllMocks();
  });

  it("uses nextCursor for next page and restores previous cursor on back", async () => {
    await act(async () => {
      root.render(React.createElement(ImportHistory));
      await flush();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=10");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("cursor=");

    const nextBtn = container.querySelector('[data-testid="next-btn"]');
    const prevBtn = container.querySelector('[data-testid="prev-btn"]');

    await act(async () => {
      nextBtn.click();
      await flush();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=c1");

    await act(async () => {
      prevBtn.click();
      await flush();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).not.toContain("cursor=");
  });
});

