/* @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import Spreadsheet from "./Spreadsheet.jsx";
import { useApiClient } from "../../../hooks/useApiClient";
import { useToast } from "../../../components/providers/ToastProvider";

const navigateMock = vi.fn();

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key, options = {}) => {
      const labels = {
        spreadsheetUploadSectionTitle: "Upload your CSV",
        spreadsheetPreviewSectionTitle: "Preview and map columns",
        spreadsheetDropzone: "Drop CSV file",
        spreadsheetEmptyCsv: "CSV file is empty.",
        spreadsheetSomethingWentWrong: "Something went wrong",
      };
      return options.defaultValue || labels[key] || key;
    },
  }),
}));

vi.mock("../../../hooks/useApiClient", () => ({
  useApiClient: vi.fn(),
}));

vi.mock("../../../components/providers/ToastProvider", () => ({
  useToast: vi.fn(),
}));

vi.mock("@shopify/polaris-icons", () => ({
  UploadIcon: {},
  FileIcon: {},
}));

vi.mock("@shopify/polaris", () => {
  const wrap = (Tag = "div") =>
    function Wrapped({ children }) {
      return React.createElement(Tag, null, children);
    };

  function Button({ children, disabled, loading, onClick, onAction }) {
    return React.createElement(
      "button",
      {
        type: "button",
        disabled: Boolean(disabled || loading),
        onClick: onClick || onAction,
      },
      children,
    );
  }

  function DropZone({ children, onDrop }) {
    const upload = (name, contents) => {
      const file = new File([contents], name, { type: "text/csv" });
      onDrop([], [file]);
    };

    return React.createElement(
      "div",
      null,
      children,
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "upload-valid",
          onClick: () => upload("valid.csv", "Title,Vendor,Status\nProduct A,Nike,active\nProduct B,Adidas,draft"),
        },
        "Upload valid CSV",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "upload-second",
          onClick: () => upload("second.csv", "Title,Vendor,Status\nProduct C,Puma,active"),
        },
        "Upload second CSV",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "upload-wide",
          onClick: () => upload("wide.csv", "Title,Vendor,Status,Tags,Handle\nWide Product,Acme,active,summer,wide-product"),
        },
        "Upload wide CSV",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "upload-empty",
          onClick: () => upload("empty.csv", ""),
        },
        "Upload empty CSV",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "upload-malformed",
          onClick: () => upload("malformed.csv", '"Title,Vendor\nProduct A'),
        },
        "Upload malformed CSV",
      ),
    );
  }

  function Select({ label, options = [], value, onChange, disabled }) {
    return React.createElement(
      "label",
      null,
      label,
      React.createElement(
        "select",
        {
          value,
          disabled,
          onChange: (event) => onChange?.(event.target.value),
        },
        options.map((option) =>
          React.createElement("option", { key: option.value, value: option.value }, option.label),
        ),
      ),
    );
  }

  function IndexTable({ headings = [], children }) {
    return React.createElement(
      "table",
      null,
      React.createElement(
        "thead",
        null,
        React.createElement(
          "tr",
          null,
          headings.map((heading) => React.createElement("th", { key: heading.title }, heading.title)),
        ),
      ),
      React.createElement("tbody", null, children),
    );
  }
  IndexTable.Row = function Row({ children }) {
    return React.createElement("tr", null, children);
  };
  IndexTable.Cell = function Cell({ children }) {
    return React.createElement("td", null, children);
  };

  return {
    Page: wrap("section"),
    Card: wrap("article"),
    BlockStack: wrap("div"),
    InlineStack: wrap("div"),
    Box: wrap("div"),
    List: Object.assign(wrap("ul"), {
      Item: wrap("li"),
    }),
    Divider: () => React.createElement("hr"),
    Badge: wrap("span"),
    Text: ({ children }) => React.createElement("span", null, children),
    Button,
    DropZone,
    Icon: () => React.createElement("span", null, "icon"),
    Select,
    IndexTable,
    Pagination: ({ hasPrevious, hasNext, onPrevious, onNext }) =>
      React.createElement(
        "div",
        null,
        React.createElement("button", { type: "button", disabled: !hasPrevious, onClick: onPrevious }, "Previous"),
        React.createElement("button", { type: "button", disabled: !hasNext, onClick: onNext }, "Next"),
      ),
    Spinner: () => React.createElement("span", null, "loading"),
    Modal: Object.assign(wrap("div"), {
      Section: wrap("section"),
    }),
    Banner: wrap("div"),
  };
});

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const previews = {
  "valid.csv": {
    uploadToken: "valid-token",
    headers: ["Title", "Vendor", "Status"],
    items: [
      { Title: "Product A", Vendor: "Nike", Status: "active" },
      { Title: "Product B", Vendor: "Adidas", Status: "draft" },
    ],
    totalCount: 2,
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
  },
  "second.csv": {
    uploadToken: "second-token",
    headers: ["Title", "Vendor", "Status"],
    items: [{ Title: "Product C", Vendor: "Puma", Status: "active" }],
    totalCount: 1,
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
  },
  "wide.csv": {
    uploadToken: "wide-token",
    headers: ["Title", "Vendor", "Status", "Tags", "Handle"],
    items: [{ Title: "Wide Product", Vendor: "Acme", Status: "active", Tags: "summer", Handle: "wide-product" }],
    totalCount: 1,
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
  },
  "empty.csv": {
    uploadToken: "empty-token",
    headers: [],
    items: [],
    totalCount: 0,
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
  },
};

describe("Spreadsheet CSV upload hook order", () => {
  let container;
  let root;
  let consoleErrorSpy;
  let showError;
  let showSuccess;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    showError = vi.fn();
    showSuccess = vi.fn();
    useToast.mockReturnValue({ showError, showSuccess });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = vi.fn(async (_url, options = {}) => {
      const file = options.body?.get?.("file");
      if (file?.name === "malformed.csv") {
        throw new Error("CSV parse failed");
      }
      return previews[file?.name] || previews["valid.csv"];
    });
    useApiClient.mockReturnValue({ request });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    consoleErrorSpy.mockRestore();
  });

  async function renderPage() {
    await act(async () => {
      root.render(React.createElement(Spreadsheet));
      await flush();
    });
  }

  async function clickUpload(testId) {
    await act(async () => {
      container.querySelector(`[data-testid="${testId}"]`).click();
      await flush();
      await flush();
    });
  }

  function expectNoHookOrderError() {
    const errorOutput = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(errorOutput).not.toContain("Rendered more hooks than during the previous render");
  }

  it("renders the upload and preview panels before a file is selected", async () => {
    await renderPage();

    expect(container.textContent).toContain("Upload your CSV");
    expect(container.textContent).toContain("Preview and map columns");
    expectNoHookOrderError();
  });

  it("uploads a valid CSV and renders preview headers, rows, and mapping UI without a hook-order crash", async () => {
    await renderPage();
    await clickUpload("upload-valid");

    expect(container.textContent).toContain("Title");
    expect(container.textContent).toContain("Vendor");
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("Product A");
    expect(container.querySelectorAll("select").length).toBe(3);
    expectNoHookOrderError();
  });

  it("uploads a second CSV and replaces stale preview rows", async () => {
    await renderPage();
    await clickUpload("upload-valid");
    await clickUpload("upload-second");

    expect(container.textContent).toContain("Product C");
    expect(container.textContent).not.toContain("Product A");
    expectNoHookOrderError();
  });

  it("shows a recoverable error for malformed CSV without route-level hook failure", async () => {
    await renderPage();
    await clickUpload("upload-malformed");

    expect(showError).toHaveBeenCalledWith("CSV parse failed");
    expectNoHookOrderError();
  });

  it("shows a recoverable error for empty CSV without route-level hook failure", async () => {
    await renderPage();
    await clickUpload("upload-empty");

    expect(showError).toHaveBeenCalledWith("CSV file is empty.");
    expectNoHookOrderError();
  });

  it("updates mapping UI when the next CSV has a different number of columns", async () => {
    await renderPage();
    await clickUpload("upload-valid");
    await clickUpload("upload-wide");

    expect(container.textContent).toContain("Wide Product");
    expect(container.textContent).toContain("Tags");
    expect(container.textContent).toContain("Handle");
    expect(container.querySelectorAll("select").length).toBe(5);
    expectNoHookOrderError();
  });
});
