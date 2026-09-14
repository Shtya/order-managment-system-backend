import { NotFoundException } from "@nestjs/common";
import { TriggerType } from "entities/automation.entity";
import { describe, expect, test, vi } from "vitest";
import {
  AssignmentCancelledTriggerMatcher,
  OrderCreatedTriggerMatcher,
  OrderUpdatedTriggerMatcher,
  ShipmentCreatedTriggerMatcher,
  ShipmentUpdatedTriggerMatcher,
  TriggerMatchersRegistry,
} from "./triggerMatchers.registry";

vi.mock("src/stores/storesIntegrations/BaseStoreProvider", () => ({
  BaseStoreProvider: class BaseStoreProvider {},
  WebhookOrderPayload: {},
}));

void OrderCreatedTriggerMatcher.prototype.shouldRun;
describe("OrderCreatedTriggerMatcher shouldRun", () => {
  const matcher = new OrderCreatedTriggerMatcher();

  test("passes matching store", () => {
    expect(
      matcher.shouldRun({ storeId: "s-1" } as never, { storeId: "s-1" } as never),
    ).toBe(true);
  });

  test("rejects other stores", () => {
    expect(
      matcher.shouldRun({ storeId: "s-1" } as never, { storeId: "s-2" } as never),
    ).toBe(false);
  });

  test("passes without store filter", () => {
    expect(matcher.shouldRun({} as never, { storeId: "s-2" } as never)).toBe(
      true,
    );
  });
});

void OrderUpdatedTriggerMatcher.prototype.shouldRun;
describe("OrderUpdatedTriggerMatcher shouldRun", () => {
  const matcher = new OrderUpdatedTriggerMatcher();

  test("passes matching status", () => {
    expect(
      matcher.shouldRun({ statusId: "st-1" } as never, { statusId: "st-1" } as never),
    ).toBe(true);
  });

  test("rejects other statuses", () => {
    expect(
      matcher.shouldRun({ statusId: "st-1" } as never, { statusId: "st-2" } as never),
    ).toBe(false);
  });

  test("passes without status filter", () => {
    expect(matcher.shouldRun({} as never, { statusId: "st-2" } as never)).toBe(
      true,
    );
  });
});

void ShipmentCreatedTriggerMatcher.prototype.shouldRun;
describe("ShipmentCreatedTriggerMatcher shouldRun", () => {
  const matcher = new ShipmentCreatedTriggerMatcher();

  test("passes matching company", () => {
    expect(
      matcher.shouldRun(
        { shippingCompanyId: "c-1" } as never,
        { shippingCompanyId: "c-1" } as never,
      ),
    ).toBe(true);
  });

  test("rejects other companies", () => {
    expect(
      matcher.shouldRun(
        { shippingCompanyId: "c-1" } as never,
        { shippingCompanyId: "c-2" } as never,
      ),
    ).toBe(false);
  });

  test("passes without company filter", () => {
    expect(
      matcher.shouldRun({} as never, { shippingCompanyId: "c-2" } as never),
    ).toBe(true);
  });
});

void ShipmentUpdatedTriggerMatcher.prototype.shouldRun;
describe("ShipmentUpdatedTriggerMatcher shouldRun", () => {
  const matcher = new ShipmentUpdatedTriggerMatcher();

  test("rejects missing configured status", () => {
    expect(
      matcher.shouldRun(
        {} as never,
        { shipments: [{ status: "shipped" }] } as never,
      ),
    ).toBe(false);
  });

  test("rejects missing payload", () => {
    expect(
      matcher.shouldRun({ shipmentStatus: "shipped" } as never, null as never),
    ).toBe(false);
  });

  test("rejects payload without shipments", () => {
    expect(
      matcher.shouldRun({ shipmentStatus: "shipped" } as never, {} as never),
    ).toBe(false);
  });

  test("passes matching single status", () => {
    expect(
      matcher.shouldRun(
        { shipmentStatus: "shipped" } as never,
        { shipments: [{ status: "shipped" }] } as never,
      ),
    ).toBe(true);
  });

  test("rejects mismatched single status", () => {
    expect(
      matcher.shouldRun(
        { shipmentStatus: "shipped" } as never,
        { shipments: [{ status: "pending" }] } as never,
      ),
    ).toBe(false);
  });

  test("passes included array status", () => {
    expect(
      matcher.shouldRun(
        { shipmentStatus: ["shipped", "delivered"] } as never,
        { shipments: [{ status: "delivered" }] } as never,
      ),
    ).toBe(true);
  });

  test("rejects excluded array status", () => {
    expect(
      matcher.shouldRun(
        { shipmentStatus: ["shipped"] } as never,
        { shipments: [{ status: "pending" }] } as never,
      ),
    ).toBe(false);
  });
});

void AssignmentCancelledTriggerMatcher.prototype.shouldRun;
describe("AssignmentCancelledTriggerMatcher shouldRun", () => {
  const matcher = new AssignmentCancelledTriggerMatcher();

  test("rejects missing event source", () => {
    expect(matcher.shouldRun({}, {})).toBe(false);
  });

  test("passes both sources when configured", () => {
    expect(
      matcher.shouldRun(
        { cancelSource: "both" } as never,
        { assignmentCancelSource: "manual" } as never,
      ),
    ).toBe(true);
  });

  test("passes matching source", () => {
    expect(
      matcher.shouldRun(
        { cancelSource: "manual" } as never,
        { assignmentCancelSource: "manual" } as never,
      ),
    ).toBe(true);
  });

  test("rejects mismatched source", () => {
    expect(
      matcher.shouldRun(
        { cancelSource: "manual" } as never,
        { assignmentCancelSource: "automatic" } as never,
      ),
    ).toBe(false);
  });

  test("defaults to automatic source", () => {
    expect(
      matcher.shouldRun(
        {} as never,
        { assignmentCancelSource: "automatic" } as never,
      ),
    ).toBe(true);
  });

  test("rejects manual event with default source", () => {
    expect(
      matcher.shouldRun(
        {} as never,
        { assignmentCancelSource: "manual" } as never,
      ),
    ).toBe(false);
  });
});

void TriggerMatchersRegistry.prototype.getMatcher;
describe("TriggerMatchersRegistry getMatcher", () => {
  const orderCreated = new OrderCreatedTriggerMatcher();
  const orderUpdated = new OrderUpdatedTriggerMatcher();
  const shipmentCreated = new ShipmentCreatedTriggerMatcher();
  const shipmentUpdated = new ShipmentUpdatedTriggerMatcher();
  const assignmentCancelled = new AssignmentCancelledTriggerMatcher();
  const registry = new TriggerMatchersRegistry(
    orderCreated,
    orderUpdated,
    shipmentCreated,
    shipmentUpdated,
    assignmentCancelled,
  );

  test("resolves every trigger type", () => {
    expect(registry.getMatcher(TriggerType.ORDER_CREATED)).toBe(orderCreated);
    expect(registry.getMatcher(TriggerType.ORDER_UPDATED)).toBe(orderUpdated);
    expect(registry.getMatcher(TriggerType.SHIPMENT_CREATED)).toBe(
      shipmentCreated,
    );
    expect(registry.getMatcher(TriggerType.SHIPMENT_UPDATED)).toBe(
      shipmentUpdated,
    );
    expect(registry.getMatcher(TriggerType.ASSIGNMENT_CANCELLED)).toBe(
      assignmentCancelled,
    );
  });

  test("throws not-found for unknown type", () => {
    let thrown: unknown;
    try {
      registry.getMatcher("nope" as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).message).toBe(
      "No trigger matcher registered for trigger type: nope",
    );
  });
});
