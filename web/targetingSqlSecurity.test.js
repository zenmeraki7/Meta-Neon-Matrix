import test from "node:test";
import assert from "node:assert/strict";
import { compileFilterAst } from "./services/targeting/compile/compileFilterAst.js";

function buildAst(value) {
  return {
    root: {
      nodeType: "group",
      logic: "AND",
      children: [
        {
          nodeType: "predicate",
          field: "vendor",
          operator: "CONTAINS",
          value,
        },
      ],
    },
    options: {
      targetGranularity: "PRODUCT",
    },
  };
}

test("SQL compiler parameterizes malicious strings", () => {
  const payloads = [
    "Nike' OR 1=1 --",
    "%'); DROP TABLE Product; --",
    '{"$gt": ""}',
  ];

  for (const payload of payloads) {
    const compiled = compileFilterAst(buildAst(payload), {
      dialect: "sql",
      context: { targetGranularity: "PRODUCT", source: "MANUAL_PREVIEW" },
    });
    assert.ok(typeof compiled.sql?.text === "string");
    assert.ok(Array.isArray(compiled.sql?.params));
    assert.equal(compiled.sql.text.includes(payload), false);
    assert.equal(
      compiled.sql.params.some((param) => String(param).includes(payload)),
      true,
    );
  }
});
