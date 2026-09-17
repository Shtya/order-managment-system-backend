import { context, propagation, Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTEL_USER_BAGGAGE_KEYS } from "./otel-user.constants";

export class UserBaggageSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const bag =
      propagation.getBaggage(parentContext) ??
      propagation.getBaggage(context.active());
    if (!bag) return;

    for (const key of OTEL_USER_BAGGAGE_KEYS) {
      const entry = bag.getEntry(key);
      if (entry?.value) {
        span.setAttribute(key, entry.value);
      }
    }
  }

  onEnd(_span: ReadableSpan): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
