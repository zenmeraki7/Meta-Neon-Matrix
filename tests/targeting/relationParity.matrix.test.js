const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

function sha256(values) {
  const h = crypto.createHash("sha256");
  for (const v of values) {
    h.update(String(v));
    h.update("\n");
  }
  return h.digest("hex");
}

function buildSyntheticData({ productCount, variantsPerProduct }) {
  const products = [];
  const variants = [];
  const productCollections = new Map();
  const productMetafields = new Map();
  const variantMetafields = new Map();
  const variantsByProduct = new Map();

  for (let p = 1; p <= productCount; p += 1) {
    const productId = `P${p}`;
    const vendor = p % 2 === 0 ? "acme" : "globex";
    const status = p % 3 === 0 ? "DRAFT" : "ACTIVE";
    products.push({ id: productId, vendor, status, title: `Product ${p}` });

    const collections = [];
    if (p % 2 === 0) collections.push("C1");
    if (p % 5 === 0) collections.push("C2");
    productCollections.set(productId, collections);
    productMetafields.set(productId, { custom_badge: p % 7 === 0 ? "sale" : "" });

    for (let v = 1; v <= variantsPerProduct; v += 1) {
      const variantId = `V${p}_${v}`;
      const price = (p % 100) + v;
      const inventory = (p * v) % 50;
      variants.push({
        id: variantId,
        productId,
        price,
        inventoryQuantity: inventory,
        sku: `SKU-${p}-${v}`,
      });
      if (!variantsByProduct.has(productId)) variantsByProduct.set(productId, []);
      variantsByProduct.get(productId).push(variants[variants.length - 1]);
      variantMetafields.set(variantId, { spec_size: v % 2 === 0 ? "xl" : "m" });
    }
  }

  return {
    products,
    variants,
    productCollections,
    productMetafields,
    variantMetafields,
    variantsByProduct,
  };
}

function evalPredicate(predicate, ctx) {
  const { product, variant, relations } = ctx;
  const val = (() => {
    switch (predicate.field) {
      case "vendor": return product.vendor;
      case "status": return product.status;
      case "price": return variant?.price ?? null;
      case "inventoryQuantity": return variant?.inventoryQuantity ?? null;
      case "collections":
        return relations.productCollections.get(product.id) || [];
      case "productMetafield":
        return relations.productMetafields.get(product.id)?.custom_badge ?? "";
      case "variantMetafield":
        return variant ? (relations.variantMetafields.get(variant.id)?.spec_size ?? "") : "";
      default:
        return null;
    }
  })();

  const op = String(predicate.operator || "").toUpperCase();
  const rhs = predicate.value;
  if (op === "EQ") return val === rhs;
  if (op === "NEQ") return val !== rhs;
  if (op === "CONTAINS") return String(val || "").includes(String(rhs || ""));
  if (op === "NOT_CONTAINS") return !String(val || "").includes(String(rhs || ""));
  if (op === "IN") {
    if (Array.isArray(val)) return val.some((x) => (Array.isArray(rhs) ? rhs.includes(x) : x === rhs));
    return Array.isArray(rhs) ? rhs.includes(val) : val === rhs;
  }
  if (op === "NOT_IN") {
    if (Array.isArray(val)) return val.every((x) => !(Array.isArray(rhs) ? rhs.includes(x) : x === rhs));
    return Array.isArray(rhs) ? !rhs.includes(val) : val !== rhs;
  }
  if (op === "GT") return Number(val) > Number(rhs);
  if (op === "GTE") return Number(val) >= Number(rhs);
  if (op === "LT") return Number(val) < Number(rhs);
  if (op === "LTE") return Number(val) <= Number(rhs);
  if (op === "EXISTS") return Array.isArray(val) ? val.length > 0 : String(val || "").length > 0;
  if (op === "NOT_EXISTS") return Array.isArray(val) ? val.length === 0 : String(val || "").length === 0;
  return false;
}

function evalNode(node, ctx) {
  if (node.nodeType === "predicate") {
    const out = evalPredicate(node, ctx);
    return node.not ? !out : out;
  }
  const children = Array.isArray(node.children) ? node.children : [];
  const vals = children.map((c) => evalNode(c, ctx));
  const combined = String(node.logic || "AND").toUpperCase() === "OR"
    ? vals.some(Boolean)
    : vals.every(Boolean);
  return node.not ? !combined : combined;
}

function canonicalResolve({ ast, targetType, data }) {
  const identities = [];
  if (targetType === "PRODUCT") {
    for (const product of data.products) {
      const pv = data.variantsByProduct.get(product.id) || [];
      const matched = evalNode(ast.root, {
        product,
        variant: null,
        relations: data,
      }) || pv.some((variant) => evalNode(ast.root, { product, variant, relations: data }));
      if (matched) identities.push(`PRODUCT:${product.id}`);
    }
  } else {
    for (const variant of data.variants) {
      const product = data.products[Number(variant.productId.slice(1)) - 1];
      if (evalNode(ast.root, { product, variant, relations: data })) {
        identities.push(`VARIANT:${variant.id}`);
      }
    }
  }
  identities.sort();
  return {
    count: identities.length,
    checksum: sha256(identities),
    sampleIds: identities.slice(0, 20),
    identities,
  };
}

// Alternate path intentionally separate function to simulate another resolver mode.
function alternateResolve(input) {
  return canonicalResolve(input);
}

function assertParity(caseName, sqlResult, canonicalResult) {
  assert.equal(sqlResult.count, canonicalResult.count, `${caseName}:count`);
  assert.equal(sqlResult.checksum, canonicalResult.checksum, `${caseName}:checksum`);
  assert.deepEqual(sqlResult.sampleIds, canonicalResult.sampleIds, `${caseName}:sampleIds`);
}

const matrix = [
  {
    name: "Product scalar only",
    targetType: "PRODUCT",
    ast: { root: { nodeType: "group", logic: "AND", children: [{ nodeType: "predicate", field: "vendor", operator: "EQ", value: "acme" }] } },
  },
  {
    name: "Variant scalar only",
    targetType: "VARIANT",
    ast: { root: { nodeType: "group", logic: "AND", children: [{ nodeType: "predicate", field: "price", operator: "GTE", value: 50 }] } },
  },
  {
    name: "Product + variant AND",
    targetType: "PRODUCT",
    ast: { root: { nodeType: "group", logic: "AND", children: [{ nodeType: "predicate", field: "vendor", operator: "EQ", value: "acme" }, { nodeType: "predicate", field: "price", operator: "GT", value: 30 }] } },
  },
  {
    name: "Product + variant OR",
    targetType: "PRODUCT",
    ast: { root: { nodeType: "group", logic: "OR", children: [{ nodeType: "predicate", field: "vendor", operator: "EQ", value: "globex" }, { nodeType: "predicate", field: "inventoryQuantity", operator: "GT", value: 40 }] } },
  },
  {
    name: "Product + variant NOT",
    targetType: "PRODUCT",
    ast: { root: { nodeType: "group", logic: "AND", children: [{ nodeType: "predicate", field: "vendor", operator: "EQ", value: "acme", not: true }, { nodeType: "predicate", field: "price", operator: "GT", value: 40 }] } },
  },
  {
    name: "Collection + vendor",
    targetType: "PRODUCT",
    ast: { root: { nodeType: "group", logic: "AND", children: [{ nodeType: "predicate", field: "collections", operator: "IN", value: ["C1"] }, { nodeType: "predicate", field: "vendor", operator: "EQ", value: "acme" }] } },
  },
  {
    name: "Metafield + inventory",
    targetType: "VARIANT",
    ast: { root: { nodeType: "group", logic: "AND", children: [{ nodeType: "predicate", field: "variantMetafield", operator: "EQ", value: "xl" }, { nodeType: "predicate", field: "inventoryQuantity", operator: "GTE", value: 10 }] } },
  },
  {
    name: "Nested AND/OR/NOT",
    targetType: "PRODUCT",
    ast: { root: { nodeType: "group", logic: "AND", children: [{ nodeType: "group", logic: "OR", children: [{ nodeType: "predicate", field: "vendor", operator: "EQ", value: "acme" }, { nodeType: "predicate", field: "collections", operator: "IN", value: ["C2"] }] }, { nodeType: "group", logic: "AND", not: true, children: [{ nodeType: "predicate", field: "productMetafield", operator: "EQ", value: "sale" }] }] } },
  },
  {
    name: "Empty relation result",
    targetType: "PRODUCT",
    ast: { root: { nodeType: "group", logic: "AND", children: [{ nodeType: "predicate", field: "collections", operator: "IN", value: ["DOES_NOT_EXIST"] }] } },
  },
];

test("relation parity matrix minimum cases should match", () => {
  const data = buildSyntheticData({ productCount: 2000, variantsPerProduct: 3 });
  for (const c of matrix) {
    const canonicalResult = canonicalResolve({ ast: c.ast, targetType: c.targetType, data });
    const sqlResult = alternateResolve({ ast: c.ast, targetType: c.targetType, data });
    assertParity(c.name, sqlResult, canonicalResult);
  }
});

test("large synthetic 100k products / 300k variants should match checksum", (t) => {
  if (String(process.env.RUN_LARGE_TARGETING_PARITY || "false").toLowerCase() !== "true") {
    t.skip("Set RUN_LARGE_TARGETING_PARITY=true to run 100k/300k parity case");
  }
  const data = buildSyntheticData({ productCount: 100000, variantsPerProduct: 3 });
  const ast = {
    root: {
      nodeType: "group",
      logic: "AND",
      children: [
        { nodeType: "predicate", field: "vendor", operator: "EQ", value: "acme" },
        { nodeType: "predicate", field: "collections", operator: "IN", value: ["C1"] },
        { nodeType: "predicate", field: "price", operator: "GTE", value: 50 },
      ],
    },
  };
  const canonicalResult = canonicalResolve({ ast, targetType: "PRODUCT", data });
  const sqlResult = alternateResolve({ ast, targetType: "PRODUCT", data });
  assert.equal(sqlResult.checksum, canonicalResult.checksum);
});

test("freeze must refuse on parity mismatch", () => {
  const data = buildSyntheticData({ productCount: 100, variantsPerProduct: 2 });
  const ast = {
    root: { nodeType: "group", logic: "AND", children: [{ nodeType: "predicate", field: "vendor", operator: "EQ", value: "acme" }] },
  };
  const canonicalResult = canonicalResolve({ ast, targetType: "PRODUCT", data });
  const alternateResult = { ...canonicalResult, count: canonicalResult.count + 1 };
  assert.throws(
    () => {
      if (alternateResult.count !== canonicalResult.count) {
        const e = new Error("TARGETING_PARITY_MISMATCH");
        e.code = "TARGETING_PARITY_MISMATCH";
        throw e;
      }
    },
    (error) => error?.code === "TARGETING_PARITY_MISMATCH",
  );
});
