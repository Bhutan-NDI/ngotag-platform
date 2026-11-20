// Starts OpenTelemetry traces and metrics for the gateway. Must stay the first import in main.ts:
// the instrumentations can only patch http, express and Nest if they exist before those load.
import { startTelemetry } from './tracer';

try {
  // eslint-disable-next-line no-console
  console.log(
    startTelemetry() ? 'OpenTelemetry SDK started successfully' : 'OpenTelemetry SDK disabled for this environment'
  );
} catch (error) {
  // eslint-disable-next-line no-console
  console.error('Failed to start OpenTelemetry SDK:', error);
}
