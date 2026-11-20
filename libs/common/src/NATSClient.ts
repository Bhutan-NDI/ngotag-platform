/* eslint-disable @typescript-eslint/no-explicit-any */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';

import { ClientProxy, NatsRecordBuilder } from '@nestjs/microservices';
import { map } from 'rxjs/operators';
import * as nats from 'nats';
import { firstValueFrom } from 'rxjs';
import ContextStorageService, { ContextStorageServiceKey } from '../../context/src/contextStorageService.interface';
import { v4 } from 'uuid';
import {
  issuanceDeadline,
  ISSUANCE_COMMANDS,
  ISSUANCE_DEADLINE_KEY,
  ISSUANCE_DEADLINE_HEADER
} from '../../context/src/issuanceDeadline';

// Without a started OpenTelemetry SDK (every service but the API gateway) this tracer and the
// propagator are no-ops.
const tracer = trace.getTracer('nats-client');

@Injectable()
export class NATSClient {
  private readonly logger: Logger;
  constructor(
    @Inject(ContextStorageServiceKey)
    private readonly contextStorageService: ContextStorageService
  ) {
    this.logger = new Logger('NATSClient');
  }

  private addIssuanceDeadline(headers: nats.MsgHdrs, cmd: string): void {
    if (ISSUANCE_COMMANDS.has(cmd)) {
      const deadline = issuanceDeadline(this.contextStorageService.get(ISSUANCE_DEADLINE_KEY));
      headers.set(ISSUANCE_DEADLINE_HEADER, String(deadline));
    }
  }

  /**
   * Runs one request/reply in a client span named after the command, so a trace shows which
   * service call was slow or failed. The span's context goes in the NATS headers (traceparent) for
   * the receiving service to continue the trace once it is instrumented.
   */
  private traced<T>(cmd: string, headers: nats.MsgHdrs, request: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(
      `send ${cmd}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'messaging.system': 'nats',
          'messaging.operation.type': 'send',
          'messaging.destination.name': cmd
        }
      },
      async (span) => {
        propagation.inject(context.active(), headers, { set: (carrier, key, value) => carrier.set(key, value) });
        try {
          return await request();
        } catch (error) {
          // Errors from a microservice arrive as plain objects, not Error instances.
          span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
          if (error instanceof Error) {
            span.recordException(error);
          }
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  sendNats(serviceProxy: Pick<ClientProxy, 'send'>, cmd: string, payload: any): Promise<any> {
    this.logger.log(`Inside NATSClient for sendNats()`);
    const pattern = { cmd };
    const contextId = this.contextStorageService.getContextId() ?? v4();
    const headers = nats.headers();
    headers.set('contextId', contextId);
    this.addIssuanceDeadline(headers, cmd);

    return this.traced(cmd, headers, () =>
      firstValueFrom(
        serviceProxy.send<string>(pattern, new NatsRecordBuilder(payload).setHeaders(headers).build()).pipe(
          /**
           * TODO: Check dependency of this mapping.
           * This might be the reason we are getting, response.response in multiple responses
           * We are maintaining them as is for now, but it need to be updated later
           */
          map((response: string) => ({
            // This map return the reposne as `{response: string}` instead of just the `string`
            response
          }))
        )
      )
    );
  }

  sendNatsMessage(serviceProxy: Pick<ClientProxy, 'send'>, cmd: string, payload: any): Promise<any> {
    const pattern = { cmd };
    const contextId = this.contextStorageService.getContextId() ?? v4();
    const headers = nats.headers();
    headers.set('contextId', contextId);
    this.addIssuanceDeadline(headers, cmd);

    return this.traced(cmd, headers, () =>
      firstValueFrom(serviceProxy.send<string>(pattern, new NatsRecordBuilder(payload).setHeaders(headers).build()))
    );
  }

  send<T>(serviceProxy: Pick<ClientProxy, 'send'>, pattern: object, payload: any): Promise<T> {
    const contextId = this.contextStorageService.getContextId() ?? v4();
    const headers = nats.headers();
    headers.set('contextId', contextId);
    const cmd = (pattern as { cmd?: string }).cmd ?? JSON.stringify(pattern);

    return this.traced(cmd, headers, () =>
      firstValueFrom(serviceProxy.send<T>(pattern, new NatsRecordBuilder(payload).setHeaders(headers).build()))
    );
  }
}
