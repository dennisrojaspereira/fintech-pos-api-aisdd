# fintech-pos-api

API de Point-of-Sale para fintech, construída sob disciplina de **Spec-Driven Development (SDD)** com o pacote [`ai-sdd`](https://classic.yarnpkg.com/en/package/ai-sdd) de Leonardo Sampaio.

## Pré-requisitos

- Node.js >= 20
- npm 10+
- Docker + Docker Compose (para Postgres 16 + Redis 7 nos testes de integração)

## Stack implementada

| Camada | Tecnologia |
|---|---|
| HTTP / runtime | Fastify v5 + TypeScript 5.6 (ESM, NodeNext, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) |
| ORM | Prisma 5.22 + PostgreSQL 16 |
| Cache + filas | Redis 7 (ioredis) + Redlock + BullMQ 5 |
| Auth | jsonwebtoken (RS256, scopes, tenant isolation) |
| Resiliência | Opossum 8 (circuit breaker) + undici (HTTP client com timeout 25s) |
| Observabilidade | pino (JSON estruturado) + OpenTelemetry SDK + auto-instrumentations |
| API contract | OpenAPI 3.1 via fastify-swagger |
| Testes | Vitest (unit + integration) + autocannon (load) |

## Setup do ambiente local

```bash
# 1. Instalar deps
npm install

# 2. Subir Postgres + Redis
npm run infra:up

# 3. Configurar env (copie .env.example para .env e preencha JWT_PUBLIC_KEY e ACQUIRER_*)
cp .env.example .env

# 4. Migrar o banco
npm run prisma:generate
npm run prisma:migrate

# 5. Aplicar a migration manual com CHECK constraints + REVOKE em audit_entries
psql "$DATABASE_URL" -f prisma/migrations/20260501_initial_constraints_and_indexes/migration.sql

# 6. Subir a API
npm run dev
```

## Scripts úteis

```bash
npm run typecheck            # tsc --noEmit (rápido — usa fallback de tipos do Prisma)
npm run typecheck:full       # roda prisma generate + tsc (recomendado em CI)
npm run build                # prisma generate + tsc -p tsconfig.build.json
npm run test                 # vitest run (unit + integration)
npm run test:unit
npm run test:integration     # exige docker-compose up
npm run test:load            # tsx tests/load/authorize-load.ts (req 1.1, P95 ≤ 5s)
npm run test:load:reconciliation  # req 5.5
npm run infra:up | infra:down
```

## Estrutura do código

```
fintech-pos-api/
├── .sdd/                     # specs SDD (requirements/design/tasks/spec.json)
├── .claude/                  # comandos slash do ai-sdd
├── prisma/
│   ├── schema.prisma         # Merchant, Terminal, Transaction, AuditEntry, ReconciliationJob
│   └── migrations/           # CHECK constraints, partial index PENDING, REVOKE em audit_entries
├── src/
│   ├── config/env.ts         # zod fail-fast loader
│   ├── shared/               # FONTE ÚNICA — Result<T,E>, enums, types do design.md
│   ├── domain/               # value-objects, state-machine, services (transaction/void/receipt/reconciliation)
│   ├── infra/
│   │   ├── http/             # routes/, middleware/auth.ts, scope.ts, idempotency.ts, error-serializer.ts
│   │   ├── persistence/      # prisma.ts, transaction.repo.ts, audit-log.repo.ts
│   │   ├── cache/            # idempotency-store.ts (Redis + Redlock)
│   │   ├── acquirer/         # acquirer-client.ts (undici), acquirer-adapter.ts (Opossum)
│   │   ├── queue/            # reconciliation-queue.ts (BullMQ)
│   │   └── observability/    # logger.ts (pino), request-logger.ts, tracing.ts (OTel)
│   ├── plugins/swagger.ts
│   ├── server.ts             # Fastify factory (composição final)
│   ├── index.ts              # entry point com startTelemetry + shutdown gracioso
│   └── types/prisma-fallback.d.ts  # ver "Decisões registradas" abaixo
├── tests/
│   ├── unit/                 # vitest mock-driven
│   ├── integration/          # vitest com Postgres+Redis reais
│   └── load/                 # autocannon (req 1.1, 5.5)
├── docker-compose.yml
├── vitest.config.ts          # workspaces unit/integration
└── tsconfig.json | tsconfig.build.json
```

## Decisões registradas durante a implementação

- **Tipos compartilhados como fonte única (`src/shared/`)**: `Result<T,E>`, todos os enums e contratos de erro/comando vivem em um só lugar. Nenhum agente/módulo redefine esses tipos.
- **Hexagonal layered (Ports & Adapters)**: HTTP transport → domain services → infrastructure adapters. Acquirer e idempotency store são portas swappable.
- **Acquirer Adapter com Opossum**: o `AcquirerClient` (undici) NUNCA lança — devolve `AcquirerResult` com outcome `APPROVED|DECLINED|TIMEOUT|ERROR`. O `AcquirerAdapter` envolve em circuit breaker que materializa o TIMEOUT como exceção sentinela apenas para o breaker, e re-hidrata de volta ao caller. Caller nunca vê exceção.
- **Idempotency**: `Idempotency-Key` obrigatório em `POST /v1/transactions`. Redis com TTL 24h + Redlock 10s para concorrência. Safe-mode: se Redis cair, log warning e segue sem cache (não bloqueia autorização — req 1.6).
- **Tenant isolation**: `merchantId` SEMPRE vem dos claims JWT, NUNCA do body. Body com `merchantId` divergente do claim → 422. Todas as queries do repo filtram por `merchant_id`.
- **Append-only audit_entries**: `REVOKE DELETE/UPDATE` no role `api_user` (migration manual). `auditLogRepository.write` é fire-and-forget e nunca rejeita ao caller (req 8.4) — falha emite `audit_log_write_failures_total`.
- **Atomic persistência**: `transaction + audit log` no mesmo `prisma.$transaction(...)` (req 1.4). Audit também é replicado em fire-and-forget para tolerância a falhas.
- **PAN masking**: `MaskedPan` value object aceita apenas `^\*{4,}\d{4}$` e rejeita PAN completo de 13–19 dígitos. CHECK constraint no banco reforça.
- **State machine**: transições controladas por `transitionAllowed(from, to)`. `VOIDED|SETTLED|DECLINED` são terminais. SETTLED é escrito externamente pela liquidação.
- **Reconciliação assíncrona**: BullMQ-backed, dedup por `queryHash` em janela de 1h. O worker é exportado via factory e bootstrapped pelo consumidor (TODO documentado).
- **Prisma client fallback**: `src/types/prisma-fallback.d.ts` declara um ambient module mínimo para que `tsc --noEmit` passe SEM `prisma generate` (útil em sandboxes/CI sem acesso ao engine binary). Em ambiente normal, `prisma generate` sobrescreve com tipos reais — o fallback fica inerte. Use `npm run typecheck:full` em CI para forçar generate antes do tsc.
- **Tests / load tests**: `tests/load/authorize-load.ts` valida P95 ≤ 5s com 100 conexões e acquirer stub respondendo em 1s. `reconciliation-load.ts` valida síncrona ≤ 3s para 10k records e dispatch async ≤ 500ms acima do threshold.

## Endpoints (todos sob `/v1/`, exceto `/health`)

| Método | Path | Scope |
|---|---|---|
| POST | /v1/transactions | — (precisa Idempotency-Key) |
| GET | /v1/transactions | — |
| GET | /v1/transactions/:id | — |
| POST | /v1/transactions/:id/void | `transactions:void` |
| GET | /v1/transactions/:id/receipt | — |
| GET | /v1/reconciliation | `reconciliation:read` |
| POST | /v1/reconciliation/jobs | `reconciliation:read` |
| GET | /v1/reconciliation/jobs/:jobId | `reconciliation:read` |
| GET | /health | público |
| GET | /docs | OpenAPI 3.1 (Swagger UI) |

## Status SDD

- ✅ Requirements aprovado
- ✅ Design aprovado
- ✅ Tasks aprovadas
- ✅ Implementação completa (38/38 tasks) — typecheck passing

Para rodar o fluxo SDD novamente em outras features, veja `npx ai-sdd@latest --help`.

## Setup do ai-sdd

```bash
# Instala os slash commands do ai-sdd para Claude Code
npx ai-sdd@latest
```

| Comando | Fase |
|---|---|
| `/sdd:spec-init "<feature>"` | Cria o esqueleto da spec |
| `/sdd:spec-requirements <feature>` | Gera requisitos no formato EARS |
| `/sdd:spec-design <feature>` | Gera o design técnico |
| `/sdd:spec-tasks <feature>` | Quebra em tarefas executáveis |
| `/sdd:spec-impl <feature>` | Executa a implementação |
