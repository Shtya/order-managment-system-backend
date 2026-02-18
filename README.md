/*
	

	- 
*/
/shipping/providers/:provider/...

Where `provider` = shipping company code  
Example:
- bosta
- dhl
- aramex


# 1) Meta Endpoints

## 1.1 List Available Shipping Providers
GET /shipping/providers
Returns all supported shipping providers.

Response:
{
  "ok": true,
  "providers": [
    { "code": "bosta", "name": "Bosta" }
  ]
}

---

## 1.2 Get Unified Shipping Statuses
GET /shipping/statuses
Returns unified status list used across all shipping companies.

Response:
{
  "ok": true,
  "statuses": [
    "new",
    "in_progress",
    "picked_up",
    "in_transit",
    "delivered",
    "returned",
    "exception",
    "cancelled",
    "terminated",
    "lost",
    "damaged",
    "on_hold",
    "action_required",
    "archived"
  ]
}


GET /shipping/providers/:provider/config
Returns current configuration for this provider.

Response: 
{
  "ok": true,
  "provider": "bosta",
  "isActive": true,
  "config": {
    "supportedAreas": ["Cairo", "Cairo:Nasr City"],
    "pricing": { ... },
    "limits": { ... }
  }
} 


POST /shipping/providers/:provider/active
Body:
{
  "isActive": true
}


POST /shipping/providers/:provider/coverage
Define allowed cities/areas.

Body:
{
  "supportedAreas": [
    "Cairo",
    "Cairo:Nasr City",
    "Giza"
  ]
}


POST /shipping/providers/:provider/pricing
Configure pricing rules in your system.

Body:
{
  "pricing": {
    "currency": "EGP",
    "default": {
      "base": 45,
      "perKg": 10,
      "codFee": 5
    },
    "byArea": {
      "Cairo": { "base": 50, "perKg": 12, "codFee": 6 },
      "Cairo:Nasr City": { "base": 55, "perKg": 12, "codFee": 6 }
    },
    "minWeightKg": 0,
    "maxWeightKg": 50
  }
} 

---

## 2.5 Set Limits

POST /shipping/providers/:provider/limits

Description:
Set shipment limits.

Body:
```json
{
  "limits": {
    "maxActiveOrders": 50,
    "maxWeightKg": 25,
    "allowedSizes": ["Small", "Medium", "Large"]
  }
}
```

---

# 3) Provider Data

---

## 3.1 Get Cities / Areas

GET /shipping/providers/:provider/areas?countryId=1

Description:
Returns provider cities + your allowed coverage.

Response:
```json
{
  "ok": true,
  "provider": "bosta",
  "allowedKeys": ["Cairo", "Cairo:Nasr City"],
  "providerAreas": { ... }
}
```

---

# 4) Pricing

---

## 4.1 Get Price Quote

POST /shipping/providers/:provider/quote

Body:
```json
{
  "city": "Cairo",
  "area": "Nasr City",
  "weightKg": 2,
  "codAmount": 0
}
```

Response:
```json
{
  "ok": true,
  "provider": "bosta",
  "currency": "EGP",
  "estimatedTotal": 75,
  "breakdown": {
    "base": 55,
    "perKg": 12,
    "weight": 2,
    "codFee": 0
  }
}
```

---

# 5) Shipment Flow

---

## 5.1 Create Shipment

POST /shipping/providers/:provider/shipments/create

Body:
```json
{
  "customerName": "Test Customer",
  "phoneNumber": "01000000000",
  "address": "123 Test Street",
  "city": "Cairo",
  "area": "Nasr City",
  "codAmount": 0,
  "weightKg": 1,
  "size": "Small"
}
```

Response:
```json
{
  "ok": true,
  "shipmentId": 1,
  "trackingNumber": "TRK123456",
  "status": "in_progress"
}
```

---

## 5.2 Assign Order to Provider

POST /shipping/providers/:provider/orders/:orderId/assign

Description:
Creates shipment and links it to an order.

Same body as Create Shipment.

---

# 6) Shipments View

---

## 6.1 List Shipments

GET /shipping/shipments

Response:
```json
{
  "ok": true,
  "items": [
    {
      "id": 1,
      "orderId": 123,
      "company": "Bosta",
      "trackingNumber": "TRK123456",
      "status": "in_transit"
    }
  ]
}
```

---

## 6.2 Get Shipment Details

GET /shipping/shipments/:id

---

## 6.3 Get Shipment Events

GET /shipping/shipments/:id/events

---

# 7) Webhook

Webhook Endpoint:

POST /shipping/webhooks/:provider

Example for Bosta:

POST /shipping/webhooks/bosta

Headers:
Authorization: Basic abc123

Body Example:
```json
{
  "_id": "providerShipmentId",
  "trackingNumber": "TRK123456",
  "state": 45
}
```

System automatically:
- Maps provider state
- Updates unifiedStatus
- Logs shipment event
- Can update order status

---

# Unified Status Logic

All providers map their states to:

- new
- in_progress
- picked_up
- in_transit
- delivered
- returned
- exception
- cancelled
- terminated
- lost
- damaged
- on_hold
- action_required
- archived

Frontend should ONLY depend on unifiedStatus.

---

# Required Environment Variables

```
BOSTA_ENV=stg
BOSTA_API_KEY=YOUR_API_KEY
BOSTA_WEBHOOK_AUTH=Basic abc123
```

---

# Future Supported Endpoints (Planned)

You can easily extend:

- Cancel shipment
- Create pickup
- Get shipment label
- Track shipment (pull mode)
- Provider services list
- Bulk create shipments
- Bulk assign orders

---

# Security Notes

- API keys stored in ENV only.
- Clients never access provider credentials.
- Webhook protected via shared secret header.
- providerRaw always sanitized.

---

# Architecture Pattern Used

Provider Router Pattern:

Frontend:
Calls one unified endpoint.

Backend:
Switches provider internally.

This ensures:
- Clean frontend
- Easy addition of new shipping providers
- Centralized business logic
