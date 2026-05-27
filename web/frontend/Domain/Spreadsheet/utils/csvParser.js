export function buildInitialColumnMappings(headers = []) {
    const initialMappings = {};
    headers.forEach((header) => {
        const lower = String(header).toLowerCase().trim();
        if (["id", "productid"].includes(lower)) initialMappings[header] = "id";
        else if (["variantid", "variant_id"].includes(lower)) initialMappings[header] = "variant_id";
        else if (lower.includes("metatitle")) initialMappings[header] = "metaTitle";
        else if (lower.includes("metadescription")) initialMappings[header] = "metaDescription";
        else if (lower === "title" || lower.includes("producttitle")) initialMappings[header] = "title";
        else if (lower.includes("sku")) initialMappings[header] = "sku";
        else if (lower.includes("compareatprice")) initialMappings[header] = "compareAtPrice";
        else if (lower.includes("price")) initialMappings[header] = "price";
        else if (lower.includes("barcode") || lower.includes("upc")) initialMappings[header] = "barcode";
        else if (lower.includes("vendor") || lower.includes("brand")) initialMappings[header] = "vendor";
        else if (lower.includes("status")) initialMappings[header] = "status";
        else if (lower.includes("description")) initialMappings[header] = "description";
        else if (lower.includes("handle")) initialMappings[header] = "handle";
        else if (lower.includes("type")) initialMappings[header] = "productType";
        else if (lower.includes("taxable")) initialMappings[header] = "taxable";
        else if (lower.includes("tags")) initialMappings[header] = "tags";
        else initialMappings[header] = "";
    });
    return initialMappings;
}
