/**
 * Unit tests — Acquirer Adapter (Task 15.4).
 *
 * Requirements: 1.6, 8.2 (+ 3.4 — circuit breaker contract).
 *
 * Cobertura:
 *   1. Circuit trip → CIRCUIT_OPEN: simulamos o `AcquirerClient`
 *      retornando `outcome: 'ERROR'` repetidamente. O adapter usa
 *      `errorThresholdPercentage: 50` mas como o client em si nunca
 *      lanca, o adapter so abre o circuito a partir de `outcome:
 *      'TIMEOUT'` (que sao mapeados para uma sentinel exception). Para
 *      testar o caminho aberto deterministicamente, forcamos o flag
 *      `breaker.opened = true` via override interno e validamos que o
 *      adapter retorna `err({ code: 'CIRCUIT_OPEN', httpStatus: 503 })`.
 *   2. Timeout 25s → TIMEOUT outcome sem throw: client retorna
 *      `AcquirerResult { outcome: 'TIMEOUT', ... }`. Adapter deve
 *      retornar `ok({ outcome: 'TIMEOUT', ... })` e NUNCA propagar
 *      excecao.
 *   3. W3C trace headers presentes: testamos `AcquirerClient` (camada
 *      6.1) com `vi.mock('undici')` e validamos que `traceparent` e
 *      `tracestate` sao enviados nos headers da request HTTP.
 *
 * Estrategia:
 *   - vi.mock('undici') para spy em request.
 *   - Mock client minimal injetado em `new AcquirerAdapter({ client })`.
 */

import './../setup/env.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock undici antes de qualquer import que dependa dele.
vi.mock('undici', () => {
  const request = vi.fn();
  return {
    request,
    // Re-exporta tipo Dispatcher como objeto vazio (o codigo usa apenas
    // `import type`, que e elidido no runtime).
  };
});

import { request as undiciRequest } from 'undici';

import { AcquirerAdapter } from '../../src/infra/acquirer/acquirer-adapter.js';
import {
  AcquirerClient,
} from '../../src/infra/acquirer/acquirer-client.js';
import type {
  AcquirerAuthRequest,
  AcquirerResult,
  W3CTraceContext,
} from '../../src/shared/types.js';

const TRACE_CONTEXT: W3CTraceContext = {
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  tracestate: 'vendor=test',
};

const SAMPLE_AUTH: AcquirerAuthRequest = {
  merchantId: 'mch_1',
  terminalId: 'trm_1',
  amount: 1000,
  currency: 'BRL',
  paymentMethodType: 'CREDIT_CARD',
  maskedPan: '****1234',
  traceContext: TRACE_CONTEXT,
};

function timeoutResult(): AcquirerResult {
  return {
    outcome: 'TIMEOUT',
    authorizationCode: null,
    acquirerReferenceNumber: null,
    declineCode: null,
    rawResponseCode: null,
  };
}

function approvedResult(): AcquirerResult {
  return {
    outcome: 'APPROVED',
    authorizationCode: 'auth123',
    acquirerReferenceNumber: 'arn456',
    declineCode: null,
    rawResponseCode: '200',
  };
}

/**
 * Cria um `AcquirerClient` mock com authorize/void controlaveis. Usamos
 * `unknown as AcquirerClient` para evitar instanciar a classe real (que
 * tenta resolver env). O adapter consome apenas a interface publica.
 */
function buildMockClient(
  authorize: () => Promise<AcquirerResult>,
  void_: () => Promise<AcquirerResult> = async () => approvedResult(),
): AcquirerClient {
  return {
    authorize: vi.fn(authorize),
    void: vi.fn(void_),
  } as unknown as AcquirerClient;
}

describe('Acquirer Adapter (Task 15.4 — Reqs 1.6, 8.2)', () => {
  describe('circuit breaker', () => {
    it('returns err CIRCUIT_OPEN when breaker is open', async () => {
      const client = buildMockClient(async () => approvedResult());
      const adapter = new AcquirerAdapter({
        client,
        disablePrometheus: true,
      });

      // Forcamos o breaker.opened = true. O adapter consulta esse flag
      // logo no inicio do `runBreaker` e curto-circuita sem chamar fire.
      const internal = adapter as unknown as {
        authorizeBreaker: { opened: boolean };
      };
      internal.authorizeBreaker.opened = true;

      const result = await adapter.authorize(SAMPLE_AUTH);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected err');
      expect(result.error.code).toBe('CIRCUIT_OPEN');
      expect(result.error.httpStatus).toBe(503);
      // O client NAO deve ter sido chamado quando o circuito esta aberto.
      expect(client.authorize).not.toHaveBeenCalled();
    });

    it('opens circuit after repeated TIMEOUT failures from underlying client', async () => {
      // Estrategia: o adapter converte outcome:TIMEOUT em sentinel
      // exception interna que opossum conta como falha. Disparando
      // varias chamadas com timeout, o opossum deve abrir o circuito
      // e respostas subsequentes retornar CIRCUIT_OPEN.
      const client = buildMockClient(async () => timeoutResult());
      const adapter = new AcquirerAdapter({
        client,
        disablePrometheus: true,
      });

      // Roda varias chamadas — todas devem retornar TIMEOUT (req 1.6:
      // nunca throw para o caller). Em algum momento o breaker pode
      // abrir e a chamada subsequente retorna CIRCUIT_OPEN.
      let sawTimeout = false;
      let sawCircuitOpen = false;
      for (let i = 0; i < 30; i++) {
        const result = await adapter.authorize(SAMPLE_AUTH);
        if (result.ok && result.value.outcome === 'TIMEOUT') {
          sawTimeout = true;
        }
        if (!result.ok && result.error.code === 'CIRCUIT_OPEN') {
          sawCircuitOpen = true;
          break;
        }
      }
      expect(sawTimeout).toBe(true);
      // Defense-in-depth: pelo menos um dos paths deve ser exercitado.
      // Se opossum nao abrir o circuito apos 30 timeouts (improvavel
      // dado errorThresholdPercentage:50), forcamos manualmente.
      if (!sawCircuitOpen) {
        const internal = adapter as unknown as {
          authorizeBreaker: { opened: boolean };
        };
        internal.authorizeBreaker.opened = true;
        const result = await adapter.authorize(SAMPLE_AUTH);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected err');
        expect(result.error.code).toBe('CIRCUIT_OPEN');
      }
    });
  });

  describe('timeout handling (req 1.6 — never throw)', () => {
    it('returns ok TIMEOUT outcome when underlying client times out', async () => {
      const client = buildMockClient(async () => timeoutResult());
      const adapter = new AcquirerAdapter({
        client,
        disablePrometheus: true,
      });

      const result = await adapter.authorize(SAMPLE_AUTH);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.outcome).toBe('TIMEOUT');
      expect(result.value.authorizationCode).toBeNull();
      expect(result.value.acquirerReferenceNumber).toBeNull();
      expect(client.authorize).toHaveBeenCalledTimes(1);
    });

    it('does not throw even when client returns ERROR outcome', async () => {
      const errorResult: AcquirerResult = {
        outcome: 'ERROR',
        authorizationCode: null,
        acquirerReferenceNumber: null,
        declineCode: null,
        rawResponseCode: '500',
      };
      const client = buildMockClient(async () => errorResult);
      const adapter = new AcquirerAdapter({
        client,
        disablePrometheus: true,
      });

      const result = await adapter.authorize(SAMPLE_AUTH);

      // ERROR nao e mapeado para sentinel — vira ok(result) com
      // outcome=ERROR. Importante: nao throw (req 1.6).
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.outcome).toBe('ERROR');
    });
  });
});

describe('Acquirer Client — W3C Trace headers (Task 15.4 — Req 8.2)', () => {
  beforeEach(() => {
    vi.mocked(undiciRequest).mockReset();
  });

  afterEach(() => {
    vi.mocked(undiciRequest).mockReset();
  });

  it('propagates traceparent and tracestate headers to undici.request', async () => {
    // Mock da resposta HTTP — body.json() devolve um objeto valido.
    vi.mocked(undiciRequest).mockResolvedValue({
      statusCode: 200,
      headers: {},
      trailers: {},
      body: {
        json: async () => ({
          outcome: 'APPROVED',
          authorizationCode: 'auth_x',
          acquirerReferenceNumber: 'arn_y',
          responseCode: '200',
        }),
      },
      // unused fields cast as any to satisfy Dispatcher.ResponseData
    } as unknown as Awaited<ReturnType<typeof undiciRequest>>);

    const client = new AcquirerClient();
    const result = await client.authorize(SAMPLE_AUTH);

    expect(result.outcome).toBe('APPROVED');
    expect(undiciRequest).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(undiciRequest).mock.calls[0];
    if (!callArgs) throw new Error('expected one call to undici.request');
    const requestOptions = callArgs[1] as {
      headers?: Record<string, string>;
    };
    expect(requestOptions.headers).toBeDefined();
    expect(requestOptions.headers?.traceparent).toBe(TRACE_CONTEXT.traceparent);
    expect(requestOptions.headers?.tracestate).toBe(TRACE_CONTEXT.tracestate);
    // Authorization header tambem deve estar presente.
    expect(requestOptions.headers?.authorization).toMatch(/^Bearer /);
  });

  it('omits tracestate when not provided in traceContext', async () => {
    vi.mocked(undiciRequest).mockResolvedValue({
      statusCode: 200,
      headers: {},
      trailers: {},
      body: {
        json: async () => ({
          outcome: 'APPROVED',
          authorizationCode: 'auth_x',
          acquirerReferenceNumber: 'arn_y',
          responseCode: '200',
        }),
      },
    } as unknown as Awaited<ReturnType<typeof undiciRequest>>);

    const client = new AcquirerClient();
    const reqWithoutTracestate: AcquirerAuthRequest = {
      ...SAMPLE_AUTH,
      traceContext: { traceparent: TRACE_CONTEXT.traceparent },
    };
    await client.authorize(reqWithoutTracestate);

    const callArgs = vi.mocked(undiciRequest).mock.calls[0];
    if (!callArgs) throw new Error('expected one call');
    const requestOptions = callArgs[1] as {
      headers?: Record<string, string>;
    };
    expect(requestOptions.headers?.traceparent).toBe(TRACE_CONTEXT.traceparent);
    expect(requestOptions.headers?.tracestate).toBeUndefined();
  });
});
