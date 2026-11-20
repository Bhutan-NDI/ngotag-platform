import { SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { of, throwError } from 'rxjs';
import { NATSClient } from './NATSClient';

type SentRecord = { headers: { get: (name: string) => string } };

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] });

beforeAll(() => provider.register());
afterEach(() => exporter.reset());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
});

const client = (): NATSClient => new NATSClient({ getContextId: () => 'ctx-1', get: () => undefined } as never);

it.each(['sendNats', 'sendNatsMessage'] as const)('runs %s in a client span and propagates it', async (method) => {
  const send = jest.fn(() => of('ok'));
  await client()[method]({ send } as never, 'get-issued-credentials', {});

  const [span] = exporter.getFinishedSpans();
  expect(span.name).toBe('send get-issued-credentials');
  expect(span.kind).toBe(SpanKind.CLIENT);
  expect(span.attributes).toMatchObject({
    'messaging.system': 'nats',
    'messaging.operation.type': 'send',
    'messaging.destination.name': 'get-issued-credentials'
  });
  const record = (send.mock.calls as unknown[][])[0][1] as SentRecord;
  expect(record.headers.get('traceparent')).toContain(span.spanContext().spanId);
  expect(record.headers.get('contextId')).toBe('ctx-1');
});

it('names a span for a pattern without cmd after the pattern', async () => {
  await client().send({ send: jest.fn(() => of('ok')) } as never, { topic: 'x' }, {});
  expect(exporter.getFinishedSpans()[0].name).toBe('send {"topic":"x"}');
});

it('marks the span as failed with a readable message when a service returns validation errors', async () => {
  const error = { status: 400, message: ['name must be a string'] };
  const send = jest.fn(() => throwError(() => error));
  await expect(client().sendNatsMessage({ send } as never, 'create-schema', {})).rejects.toBe(error);

  const [span] = exporter.getFinishedSpans();
  expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: '["name must be a string"]' });
});
