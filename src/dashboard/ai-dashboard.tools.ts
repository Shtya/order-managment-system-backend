export type ToolGroup =
  | "Messaging"
  | "Agent Chat"
  | "AI Address"
  | "AI Design"
  | "Media Processing";

export const TOOL_CATALOG: Record<string, { label: string; group: ToolGroup }> = {
  send_text: { label: "Send Text Message", group: "Messaging" },
  send_image: { label: "Send Image", group: "Messaging" },
  send_buttons: { label: "Send Buttons", group: "Messaging" },
  send_list: { label: "Send List", group: "Messaging" },
  send_whatsapp_template: { label: "Send WhatsApp Template", group: "Messaging" },
  list_whatsapp_templates: { label: "List WhatsApp Templates", group: "Messaging" },
  react_to_message: { label: "React To Message", group: "Messaging" },
  request_location: { label: "Request Location", group: "Messaging" },
  send_location: { label: "Send Location", group: "Messaging" },
  confirm_pending_action: { label: "Confirm Pending Action", group: "Messaging" },
  cancel_pending_action: { label: "Cancel Pending Action", group: "Messaging" },

  search_products: { label: "Search Products", group: "Agent Chat" },
  get_product_details: { label: "Product Details", group: "Agent Chat" },
  search_bundles: { label: "Search Bundles", group: "Agent Chat" },
  get_bundle_details: { label: "Bundle Details", group: "Agent Chat" },
  list_categories: { label: "List Categories", group: "Agent Chat" },
  get_my_orders: { label: "Get My Orders", group: "Agent Chat" },
  get_order_details: { label: "Order Details", group: "Agent Chat" },
  get_my_campaign_offers: { label: "Campaign Offers", group: "Agent Chat" },
  request_order: { label: "Request Order", group: "Agent Chat" },
  request_campaign_order: { label: "Request Campaign Order", group: "Agent Chat" },
  request_add_order_items: { label: "Add Order Items", group: "Agent Chat" },
  request_update_order_items: { label: "Update Order Items", group: "Agent Chat" },
  request_replace_order_items: { label: "Replace Order Items", group: "Agent Chat" },
  request_update_order_info: { label: "Update Order Info", group: "Agent Chat" },
  request_cancel_order: { label: "Cancel Order", group: "Agent Chat" },
  request_confirm_order: { label: "Confirm Order", group: "Agent Chat" },
  request_postpone_order: { label: "Postpone Order", group: "Agent Chat" },
  request_update_customer: { label: "Update Customer", group: "Agent Chat" },

  get_cities: { label: "City Lookup", group: "AI Address" },
  get_city: { label: "Get City", group: "AI Address" },
  get_areas_by_city: { label: "Areas By City", group: "AI Address" },
  get_my_addresses: { label: "Get Addresses", group: "AI Address" },
  get_shipping_zones: { label: "Shipping Zones", group: "AI Address" },
  get_shipping_districts: { label: "Shipping Districts", group: "AI Address" },
  get_location_by_coordinates: { label: "Location By Coordinates", group: "AI Address" },
  check_shipping_coverage: { label: "Shipping Coverage", group: "AI Address" },
  request_add_customer_address: { label: "Add Customer Address", group: "AI Address" },
  request_remove_customer_address: { label: "Remove Customer Address", group: "AI Address" },
  request_update_customer_address: { label: "Update Customer Address", group: "AI Address" },
  request_set_default_address: { label: "Set Default Address", group: "AI Address" },
  request_address_update: { label: "Address Update", group: "AI Address" },
  report_address_conflict: { label: "Report Address Conflict", group: "AI Address" },
  report_address_issues: { label: "Report Address Issues", group: "AI Address" },
  close_address_task: { label: "Close Address Task", group: "AI Address" },
  bulk_update_orders_shipping: { label: "Bulk Update Shipping", group: "AI Address" },
};

export function describeTool(name: string): { label: string; group: ToolGroup } {
  return (
    TOOL_CATALOG[name] || {
      label: name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      group: "Agent Chat",
    }
  );
}
