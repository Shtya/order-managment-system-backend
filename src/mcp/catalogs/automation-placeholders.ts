// Order/global tokens that may appear inside free-text step fields as
// `{{<path>}}`. The engine resolves them at run time in
// FlowNodeHandler.deepReplaceVariables via getValueByPath(order, path) with the
// `global.` prefix handled separately. Paths mirror the frontend order-property
// selector, which inserts exactly `{{<path>}}` (no `order.` prefix).

export const ORDER_PLACEHOLDER_PATHS: { path: string; label: string }[] = [
  { path: "orderNumber", label: "Order Number" },
  { path: "customerName", label: "Customer Name" },
  { path: "phoneNumber", label: "Phone Number" },
  { path: "address", label: "Address" },
  { path: "city", label: "City" },
  { path: "area", label: "Area" },
  { path: "landmark", label: "Landmark" },
  { path: "deposit", label: "Deposit" },
  { path: "productsTotal", label: "Products Total" },
  { path: "shippingCost", label: "Shipping Cost" },
  { path: "discount", label: "Discount" },
  { path: "additionalFees", label: "Additional Fees" },
  { path: "finalTotal", label: "Final Total" },
  { path: "status.name", label: "Status" },
  { path: "store.name", label: "Store" },
  { path: "paymentMethod", label: "Payment Method" },
  { path: "paymentStatus", label: "Payment Status" },
  { path: "shippingCompany.name", label: "Shipping Company" },
  { path: "trackingNumber", label: "Tracking Number" },
  { path: "shippedAt", label: "Shipped At" },
  { path: "deliveredAt", label: "Delivered At" },
  { path: "created_at", label: "Created At" },
  { path: "allowOpenPackage", label: "Allow Open Package" },
  { path: "rejectReason", label: "Reject Reason" },
  { path: "rejectedAt", label: "Rejected At" },
  { path: "postponedDate", label: "Postponed Date" },
  { path: "returnedAt", label: "Returned At" },
  { path: "customerNotes", label: "Customer Notes" },
  { path: "duplicateCount", label: "Duplicate Count" },
  { path: "originalOrderNumber", label: "Original Order Number" },
  { path: "items[].variant.product.name", label: "Product Name (all items)" },
  { path: "items[].variant.sku", label: "SKU (all items)" },
  { path: "items[].quantity", label: "Quantity (all items)" },
  { path: "items[].unitPrice", label: "Unit Price (all items)" },
  { path: "items[].unitCost", label: "Unit Cost (all items)" },
  { path: "items[].lineTotal", label: "Line Total (all items)" },
  { path: "items[0].variant.product.name", label: "First item product name" },
  { path: "items[0].variant.sku", label: "First item SKU" },
  { path: "items[0].quantity", label: "First item quantity" },
  { path: "items[0].unitPrice", label: "First item unit price" },
  { path: "items[0].unitCost", label: "First item unit cost" },
  { path: "items[0].lineTotal", label: "First item line total" },
  { path: "items[-1].variant.product.name", label: "Last item product name" },
  { path: "items[-1].variant.sku", label: "Last item SKU" },
  { path: "items[-1].quantity", label: "Last item quantity" },
  { path: "items[-1].unitPrice", label: "Last item unit price" },
  { path: "items[-1].unitCost", label: "Last item unit cost" },
  { path: "items[-1].lineTotal", label: "Last item line total" },
];

export const GLOBAL_PLACEHOLDER_PATHS: { path: string; label: string }[] = [
  { path: "global.brandName", label: "Brand Name" },
  { path: "global.companyEmail", label: "Company Email" },
  { path: "global.companyWebsite", label: "Company Website" },
  { path: "global.companyPhone", label: "Company Phone" },
  { path: "global.companyAddress", label: "Company Address" },
  { path: "global.companyCurrency", label: "Company Currency" },
];

export const PLACEHOLDER_DATE_FORMATS = [
  "DD-MM-YYYY",
  "DD/MM/YYYY",
  "YYYY-MM-DD",
  "MM-DD-YYYY",
  "DD.MM.YYYY",
  "WeekdayShort D MonthShort",
  "Weekday D Month",
  "Weekday D Month YYYY",
  "D Month",
  "D Month YYYY",
] as const;

// Returned once at the top of the step catalog so the shared context is not
// repeated on every placeholder-capable field.
export const PLACEHOLDER_DEFINITION = {
  what: "A placeholder is a {{...}} token inside a text value. It is replaced with order or company data when the step runs.",
  syntax: "{{<path>}}",
  example: "Hi {{customerName}}, your order {{orderNumber}} arrives on {{global.date.1.DD-MM-YYYY}}.",
  whenUsed:
    "Only inside string fields whose JSON Schema is marked supportsPlaceholders: true. Never in ids, enum values, phone numbers, URLs, or variablePath fields.",
  fieldMarkers: {
    supportsPlaceholders: "The field is text and may contain {{path}} tokens.",
    placeholderPath: "The field takes one path from orderPaths/globalPaths without the {{ }} braces.",
  },
  orderPaths: ORDER_PLACEHOLDER_PATHS.map((p) => p.path),
  globalPaths: GLOBAL_PLACEHOLDER_PATHS.map((p) => p.path),
  datePath: "global.date.<offset>.<format>",
  dateFormats: PLACEHOLDER_DATE_FORMATS,
  rules: [
    "Write the path exactly as listed; paths are case-sensitive.",
    'Do not prefix order paths with "order.".',
    "Use items[] to render every item, items[0] for the first, and items[-1] for the last.",
    "A missing path resolves to an empty string.",
  ],
} as const;

export const PLACEHOLDER_PATH_MARKER = { placeholderPath: true } as const;
