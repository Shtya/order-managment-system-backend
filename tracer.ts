import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel, metrics } from '@opentelemetry/api';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import { logs } from '@opentelemetry/api-logs';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { HostMetrics } from '@opentelemetry/host-metrics';
import Pyroscope from '@pyroscope/nodejs';
import { UserBaggageSpanProcessor } from './common/observability/user-baggage-span-processor';
const env = process.env.NODE_ENV || 'development';
const rootDir = process.cwd();

// 1. Path to the environment-specific file (e.g., .env.development or .env.production)
const envSpecificPath = path.resolve(rootDir, `.env.${env}`);

// 2. Path to the base .env file
const defaultEnvPath = path.resolve(rootDir, '.env');

// Load environment-specific file first (takes priority)
if (fs.existsSync(envSpecificPath)) {
  dotenv.config({ path: envSpecificPath });
}

// Load base .env as fallback for any shared variables (does not overwrite existing)
if (fs.existsSync(defaultEnvPath)) {
  dotenv.config({ path: defaultEnvPath });
}

const instanceId = process.env.GRAFANA_INSTANCE_ID;
const token = process.env.GRAFANA_TOKEN;
const authHeader = instanceId && token
  ? `Basic ${Buffer.from(`${instanceId}:${token}`).toString('base64')}`
  : '';

const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, // Driven purely by .env now
  headers: { Authorization: authHeader },
});

const logExporter = new OTLPLogExporter({
  url: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  headers: {
    Authorization: authHeader,
  },
});

const loggerProvider = new LoggerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME,
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  }),
  processors: [
    new BatchLogRecordProcessor({ exporter: logExporter }),
  ],
});

logs.setGlobalLoggerProvider(loggerProvider);

const metricExporter = new OTLPMetricExporter({
  url: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  headers: {
    Authorization: authHeader,
  },
});

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 10000,
});

// Create SDK instance with comprehensive configuration
const sdk = new NodeSDK({
  // 1. Identify your service in Grafana
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME,
    'deployment.environment': process.env.NODE_ENV ?? 'development',
  }),

  spanProcessors: [
    new UserBaggageSpanProcessor(),
    new BatchSpanProcessor(traceExporter),
  ],

  metricReader,

  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable instrumentations that might cause issues
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // Configure HTTP instrumentation for better trace context
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        ignoreIncomingRequestHook: (req) => {
          // Ignore health check endpoints
          return req.url?.includes('/health') || req.url?.includes('/metrics') || false;
        },
      },
    }),
  ],
});

sdk.start();

// Register CPU/memory/network host metrics through the same MeterProvider
// that NodeSDK just registered globally (so they export via metricReader above).
const hostMetrics = new HostMetrics({
  meterProvider: metrics.getMeterProvider(),
  name: process.env.OTEL_SERVICE_NAME,
});
hostMetrics.start();

if (process.platform !== 'win32') {
  Pyroscope.init({
    serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS, // e.g. Grafana Cloud Profiles URL
    appName: process.env.OTEL_SERVICE_NAME, // reuse the same service name as your OTel resource
    basicAuthUser: process.env.PYROSCOPE_BASIC_AUTH_USER,
    basicAuthPassword: process.env.PYROSCOPE_BASIC_AUTH_PASSWORD,
    tags: {
      environment: process.env.NODE_ENV ?? 'development',
    },
    wall: {
      collectCpuTime: true, // required if you want actual CPU profiles, not just wall-clock
    },
  });

  Pyroscope.start();
}

export default sdk;