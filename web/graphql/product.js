export const PRODUCT_NESTED_CONNECTION_PAGE_SIZE = 250;

const PRODUCT_CORE_FIELDS = `
  __typename
  id
  title
  handle
  status
  productType
  vendor
  tags
  templateSuffix
  createdAt
  updatedAt
  publishedAt
  onlineStoreUrl
  descriptionHtml

  seo {
    __typename
    title
    description
  }

  totalInventory

  category {
    __typename
    id
    name
  }

  options {
    __typename
    id
    name
    position
    values
  }

  featuredMedia {
    __typename
    ... on MediaImage {
      id
      alt
      preview {
        __typename
        image {
          __typename
          url
          altText
        }
      }
    }
  }
`;

const VARIANT_FIELDS = `
  __typename
  id
  title
  sku
  barcode
  price
  compareAtPrice
  inventoryQuantity
  inventoryPolicy
  taxable
  taxCode
  position

  selectedOptions {
    __typename
    name
    value
  }

  inventoryItem {
    __typename
    id
    tracked
    requiresShipping

    unitCost {
      __typename
      amount
    }

    countryCodeOfOrigin
    harmonizedSystemCode

    measurement {
      __typename
      weight {
        __typename
        value
        unit
      }
    }
  }
`;

const COLLECTION_CONNECTION = `
  collections(first: ${PRODUCT_NESTED_CONNECTION_PAGE_SIZE}) {
    edges {
      node {
        __typename
        id
        title
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

const VARIANT_CONNECTION = `
  variants(first: ${PRODUCT_NESTED_CONNECTION_PAGE_SIZE}) {
    edges {
      node {
        ${VARIANT_FIELDS}
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

export const graphqlProductsBulkSyncQuery = `{
  products {
    edges {
      node {
        ${PRODUCT_CORE_FIELDS}

        metafields(first: ${PRODUCT_NESTED_CONNECTION_PAGE_SIZE}) {
          edges {
            node {
              __typename
              id
              namespace
              key
              type
              value
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }

        ${COLLECTION_CONNECTION}

        ${VARIANT_CONNECTION}
      }
    }
  }
}`;

export const graphqlProductsExportQuery = `
  query ProductsExport($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      edges {
        node {
          ${PRODUCT_CORE_FIELDS}

          ${COLLECTION_CONNECTION}

          ${VARIANT_CONNECTION}
        }
      }

      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
