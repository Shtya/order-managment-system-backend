import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import {
  BillingOperationKey,
  BillingServiceKey,
} from "entities/billing.entity";

export class BillingOperationNotFoundError extends InternalServerErrorException {
  constructor(service: BillingServiceKey, operation: BillingOperationKey) {
    super(`Billing operation not found: ${service}:${operation}`);
    this.name = "BillingOperationNotFoundError";
  }
}

export class BillingConfigurationError extends InternalServerErrorException {
  constructor(message: string) {
    super(message);
    this.name = "BillingConfigurationError";
  }
}

export class BillingValidationError extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = "BillingValidationError";
  }
}

export class BillingConflictError extends ConflictException {
  constructor(message: string) {
    super(message);
    this.name = "BillingConflictError";
  }
}

export class IdempotencyKeyReuseError extends BillingConflictError {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key reused with a different request: ${idempotencyKey}`,
    );
    this.name = "IdempotencyKeyReuseError";
  }
}

export class AuthorizationReleasedError extends ConflictException {
  constructor(message = "Authorization already released") {
    super(message);
    this.name = "AuthorizationReleasedError";
  }
}

export class AuthorizationNotFoundError extends NotFoundException {
  constructor(authorizationId: string) {
    super(`Billing authorization not found: ${authorizationId}`);
    this.name = "AuthorizationNotFoundError";
  }
}
