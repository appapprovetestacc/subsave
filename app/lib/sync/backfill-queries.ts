// AppApprove sync — typed GraphQL backfill queries. Each resource gets
// its own query string + node-shape interface + node-to-row mapper. The
// queries use cursor-based pagination on the root connection (`first` +
// `after`), sorted by UPDATED_AT where the connection supports it so
// resuming a backfill from a checkpoint is reliable.
//
// Bind via your shopify-app-remix admin GraphQL client:
//   const res = await admin.graphql(productBackfillQuery, {
//     variables: { first: 50, after: cursor },
//   });

export const productsBackfillQuery = `query ProductBackfill($first: Int!, $after: String) {
  products(first: $first, after: $after, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      handle
      title
      status
      updatedAt
    }
  }
}`;

export const variantsBackfillQuery = `query VariantBackfill($first: Int!, $after: String) {
  productVariants(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      price
      inventoryQuantity
      updatedAt
      product { id }
    }
  }
}`;

export const ordersBackfillQuery = `query OrderBackfill($first: Int!, $after: String) {
  orders(first: $first, after: $after, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      email
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      displayFinancialStatus
      displayFulfillmentStatus
      updatedAt
    }
  }
}`;

export interface ProductNode {
  id: string;
  handle: string | null;
  title: string;
  status: string | null;
  updatedAt: string;
}

export interface VariantNode {
  id: string;
  sku: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  updatedAt: string;
  product: { id: string };
}

export interface OrderNode {
  id: string;
  name: string;
  email: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  updatedAt: string;
}

export function productNodeToRow(shop: string, node: ProductNode, payloadHash: string) {
  return {
    remoteId: node.id,
    shop,
    title: node.title,
    handle: node.handle,
    status: node.status,
    payloadHash,
    payload: node as unknown as Record<string, unknown>,
    remoteUpdatedAt: node.updatedAt,
  };
}

export function variantNodeToRow(shop: string, node: VariantNode, payloadHash: string) {
  return {
    remoteId: node.id,
    shop,
    productRemoteId: node.product.id,
    sku: node.sku,
    price: node.price,
    inventoryQuantity: node.inventoryQuantity,
    payloadHash,
    payload: node as unknown as Record<string, unknown>,
    remoteUpdatedAt: node.updatedAt,
  };
}

export function orderNodeToRow(shop: string, node: OrderNode, payloadHash: string) {
  return {
    remoteId: node.id,
    shop,
    name: node.name,
    email: node.email,
    totalPrice: node.currentTotalPriceSet.shopMoney.amount,
    currencyCode: node.currentTotalPriceSet.shopMoney.currencyCode,
    financialStatus: node.displayFinancialStatus,
    fulfillmentStatus: node.displayFulfillmentStatus,
    payloadHash,
    payload: node as unknown as Record<string, unknown>,
    remoteUpdatedAt: node.updatedAt,
  };
}

export const SYNC_BACKFILL_PAGE_SIZE = 50;
