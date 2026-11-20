// OpenTelemetry. Inert unless IS_ENABLE_OTEL=true.
//
// Every service that uses @credebl/logger imports this module for otelLogger, so the log export
// below runs in all of them. Traces and metrics run only where startTelemetry() is called: the API
// gateway, through instrument.ts.
import * as dotenv from 'dotenv';
import * as process from 'process';
import type { IncomingMessage, RequestOptions } from 'http';

import { type Attributes, DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import type { Logger } from '@opentelemetry/api-logs';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { resourceFromAttributes } from '@opentelemetry/resources';

dotenv.config();

const otelEnabled = 'true' === process.env.IS_ENABLE_OTEL;

// Not in the stable semantic-conventions entry point.
const ATTR_SERVICE_INSTANCE_ID = 'service.instance.id';

// The load balancer health-checks the Swagger UI at /api; neither it nor its assets need a trace.
// Matched on the path only, so a query string cannot defeat it.
export const isUntracedRequest = (url: string | undefined): boolean =>
  /^\/api(-json|-yaml)?(\/|$)/.test((url ?? '').split('?')[0]);

// Query values can carry secrets (tokens, invitation payloads); the names are kept, the values are not.
export const redactedQuery = (search: string): string => search.replace(/^\?/, '').replace(/=[^&]*/g, '=[redacted]');

// Attributes returned from the start-span hooks replace what the HTTP instrumentation recorded.
export const incomingUrlAttributes = (request: IncomingMessage): Attributes => {
  const url = request.url ?? '';
  const queryStart = url.indexOf('?');
  return 0 > queryStart ? {} : { 'url.query': redactedQuery(url.slice(queryStart)) };
};

export const outgoingUrlAttributes = (options: RequestOptions): Attributes => {
  const host = `${options.hostname ?? options.host ?? 'localhost'}${options.port ? `:${options.port}` : ''}`;
  return { 'url.full': `${options.protocol ?? 'http:'}//${host}${(options.path ?? '/').split('?')[0]}` };
};

if (otelEnabled) {
  // The SDK reports failed exports through this logger, so it stays on, at WARN.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  // The stable HTTP conventions only: the old ones label the request-duration metric with the
  // client's Host header (a new series per scanner) and record the full URL with its query string.
  // Must be set before the HTTP instrumentation is built.
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'http';

  const missing = [
    'OTEL_TRACES_OTLP_ENDPOINT',
    'OTEL_LOGS_OTLP_ENDPOINT',
    'OTEL_METRICS_OTLP_ENDPOINT',
    'OTEL_HEADERS_KEY'
  ].filter((name) => !process.env[name]);
  if (0 < missing.length) {
    // eslint-disable-next-line no-console
    console.warn(`OpenTelemetry is enabled but ${missing.join(', ')} not set`);
  }
}

// The release workflow builds the source commit into the gateway image; an explicit
// OTEL_SERVICE_VERSION wins.
const serviceVersion = process.env.OTEL_SERVICE_VERSION || process.env.SOURCE_COMMIT;

const resource = resourceFromAttributes({
  ...(process.env.OTEL_SERVICE_NAME ? { [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME } : {}),
  ...(serviceVersion ? { [ATTR_SERVICE_VERSION]: serviceVersion } : {}),
  ...(process.env.HOSTNAME ? { [ATTR_SERVICE_INSTANCE_ID]: process.env.HOSTNAME } : {})
});

const headers = { Authorization: `Api-Key ${process.env.OTEL_HEADERS_KEY}` };

let otelSDK: NodeSDK | null = null;
let otelLogger: Logger | null = null;
let otelLoggerProviderInstance: LoggerProvider | null = null;

if (otelEnabled) {
  const logProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(new OTLPLogExporter({ url: process.env.OTEL_LOGS_OTLP_ENDPOINT, headers }))
    ]
  });
  otelLogger = logProvider.getLogger(process.env.OTEL_LOGGER_NAME);
  otelLoggerProviderInstance = logProvider;

  // Flushes what is buffered, then exits as before. Bounded, so an unreachable collector cannot
  // hold the task until ECS kills it.
  process.on('SIGTERM', () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        // eslint-disable-next-line no-console
        console.error('Telemetry flush did not finish in 5s; exiting without it');
        resolve();
      }, 5000);
    });
    const flush = Promise.all([otelSDK?.shutdown(), logProvider.shutdown()]).then(
      // eslint-disable-next-line no-console
      () => console.log('SDK and Logger shut down successfully'),
      // eslint-disable-next-line no-console
      (err) => console.error('Error during telemetry shutdown', err)
    );
    Promise.race([flush, timeout]).finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  });
}

/**
 * Starts traces and metrics. The instrumentations patch http, express and Nest when they are built,
 * so this must run before those modules are first required: instrument.ts, the first import of
 * main.ts. Returns the started SDK, or null when OpenTelemetry is off.
 */
export const startTelemetry = (): NodeSDK | null => {
  if (!otelEnabled || otelSDK) {
    return otelSDK;
  }
  otelSDK = new NodeSDK({
    resource,
    autoDetectResources: false,
    traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_TRACES_OTLP_ENDPOINT, headers }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: process.env.OTEL_METRICS_OTLP_ENDPOINT, headers }),
      exportIntervalMillis: 60_000
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => isUntracedRequest(request.url),
        startIncomingSpanHook: incomingUrlAttributes,
        startOutgoingSpanHook: outgoingUrlAttributes
      }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      // Event loop delay, GC and heap.
      new RuntimeNodeInstrumentation()
    ]
  });
  otelSDK.start();
  return otelSDK;
};

export { otelSDK, otelLogger, otelLoggerProviderInstance };
