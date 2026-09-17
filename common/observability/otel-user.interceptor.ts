import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { context, propagation, trace } from "@opentelemetry/api";
import { Observable } from "rxjs";
import { tenantId } from "src/purchases/purchases.service";
import { OTEL_USER_ATTR } from "./otel-user.constants";

@Injectable()
export class OtelUserInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== "http") {
      return next.handle();
    }

    const req = ctx.switchToHttp().getRequest();
    const user = req?.user;
    if (!user?.id) {
      return next.handle();
    }

    const userId = String(user.id);
    const userName = user.name ? String(user.name) : "";
    const adminId = tenantId(user);

    const span = trace.getActiveSpan();
    span?.setAttribute(OTEL_USER_ATTR.id, userId);
    if (userName) {
      span?.setAttribute(OTEL_USER_ATTR.name, userName);
    }
    if (adminId) {
      span?.setAttribute(OTEL_USER_ATTR.adminId, String(adminId));
    }

    let bag =
      propagation.getBaggage(context.active()) ?? propagation.createBaggage();
    bag = bag.setEntry(OTEL_USER_ATTR.id, { value: userId });
    if (userName) {
      bag = bag.setEntry(OTEL_USER_ATTR.name, { value: userName });
    }
    if (adminId) {
      bag = bag.setEntry(OTEL_USER_ATTR.adminId, { value: String(adminId) });
    }

    const otelCtx = propagation.setBaggage(context.active(), bag);

    return new Observable((subscriber) => {
      return context.with(otelCtx, () => next.handle().subscribe(subscriber));
    });
  }
}
