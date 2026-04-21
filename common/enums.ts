// common/enums.ts
export enum ApprovalStatus {
  ACCEPTED = "accepted",
  PENDING = "pending",
  REJECTED = "rejected",
}



export enum ReturnStatus {
  COMPLETED = "completed",
  PENDING = "pending",
  CANCELLED = "cancelled",
}

export enum PurchaseReturnType {
  CASH_REFUND = "cash_refund",
  BANK_TRANSFER = "bank_transfer",
  SUPPLIER_DEDUCTION = "supplier_deduction",
}

export enum OrderType {
  DISTRIBUTED = "distributed",
  NORMAL = "normal",
}

export enum PaymentMethod {
  COD = "COD",
  WALLET = "wallet",
  INSTA_PAY = "insta_pay",
  CASH = "cash",
  BANK = "bank",
}

export enum PaymentStatus {
  PAID = "paid",
  PARTIALLY_PAID = "partially_paid",
  UNPAID = "unpaid",
}
