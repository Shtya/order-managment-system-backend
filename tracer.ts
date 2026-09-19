import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { metrics } from '@opentelemetry/api';
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

let sdk: NodeSDK | undefined;

if (env !== 'development') {
  const rootDir = process.cwd();

  // Load environment-specific file first.
  const envSpecificPath = path.resolve(rootDir, `.env.${env}`);

  // Load base .env as fallback.
  const defaultEnvPath = path.resolve(rootDir, '.env');

  if (fs.existsSync(envSpecificPath)) {
    dotenv.config({ path: envSpecificPath });
  }

  if (fs.existsSync(defaultEnvPath)) {
    dotenv.config({ path: defaultEnvPath });
  }

  const instanceId = process.env.GRAFANA_INSTANCE_ID;
  const token = process.env.GRAFANA_TOKEN;

  const authHeader =
    instanceId && token
      ? `Basic ${Buffer.from(`${instanceId}:${token}`).toString('base64')}`
      : '';

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME,
    'deployment.environment': env,
  });

  // -------------------------
  // Traces
  // -------------------------

  const traceExporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    headers: {
      Authorization: authHeader,
    },
  });

  // -------------------------
  // Logs
  // -------------------------

  const logExporter = new OTLPLogExporter({
    url: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    headers: {
      Authorization: authHeader,
    },
  });

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: logExporter,
      }),
    ],
  });

  logs.setGlobalLoggerProvider(loggerProvider);

  // -------------------------
  // Metrics
  // -------------------------

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

  // -------------------------
  // OpenTelemetry SDK
  // -------------------------

  sdk = new NodeSDK({
    resource,

    spanProcessors: [
      new UserBaggageSpanProcessor(),
      new BatchSpanProcessor(traceExporter),
    ],

    metricReader,

    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': {
          enabled: false,
        },

        '@opentelemetry/instrumentation-http': {
          enabled: true,

          ignoreIncomingRequestHook: (req) => {
            return (
              req.url?.includes('/health') ||
              req.url?.includes('/metrics') ||
              false
            );
          },
        },
      }),
    ],
  });

  sdk.start();

  // -------------------------
  // Host Metrics
  // -------------------------

  const hostMetrics = new HostMetrics({
    meterProvider: metrics.getMeterProvider(),
    name: process.env.OTEL_SERVICE_NAME,
  });

  hostMetrics.start();

  // -------------------------
  // Pyroscope
  // -------------------------

  if (process.platform !== 'win32') {
    Pyroscope.init({
      serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS,
      appName: process.env.OTEL_SERVICE_NAME,
      basicAuthUser: process.env.PYROSCOPE_BASIC_AUTH_USER,
      basicAuthPassword: process.env.PYROSCOPE_BASIC_AUTH_PASSWORD,

      tags: {
        environment: env,
      },

      wall: {
        collectCpuTime: true,
      },
    });

    Pyroscope.start();
  }
}

export default sdk;
