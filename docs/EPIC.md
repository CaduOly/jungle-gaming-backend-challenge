# Épico — Distributed Wagering Processor

Fonte: plano `verifique-o-readme-e-spicy-parrot.md` + enunciado no `README.md`.

## Objetivo

Entregar o serviço de carteira (wallet + wagering) com nota máxima em correção financeira,
concorrência, idempotência e mensageria/falhas, sem nenhuma falha eliminatória.

## Time e fluxo

| Papel | Quem |
| --- | --- |
| Tech lead | coordena, quebra tasks, faz merge na `dev` |
| Dev A | tasks de domínio, persistência, SQS |
| Dev B | tasks de mensageria, HTTP, workers, observabilidade |
| QA | valida **toda** task antes do merge |

Fluxo de cada task:

1. Tech lead cria `feat/TXX-<slug>` a partir da `dev`.
2. Dev implementa em TDD e faz commit na branch da task.
3. QA roda lint, arch, unit e integração, revisa os critérios de aceite e procura bugs.
4. Bug → volta para o dev que fez a task → QA de novo.
5. QA aprovado → merge `--no-ff` na `dev` e push da `dev`.
6. **`main` é só do Carllos.** Ninguém do time faz commit, merge ou push na `main`.

## Tasks

| ID | Task | Dono | Depende de | Etapa do plano |
| --- | --- | --- | --- | --- |
| T01 | Scaffold, lint, dependency-cruiser, compose (PG + LocalStack), helpers de teste, spike LocalStack | Dev A | — | 1 |
| T01b | Hardening da T01 (achados do QA): lint de dinheiro, healthcheck do LocalStack, limpeza de recursos de teste, regras extras de arquitetura | Dev A | T01 | 1 |
| T02 | `Money` + erros base + `IUseCase` + ports compartilhados | Dev A | T01 | 2 |
| T03 | `Wallet` + `WalletLedgerEntry` + reconciliação pura (o `WalletBalanceChanged` entra depois da T04) | Dev A | T02 | 3 |
| T04 | Messaging: `InboxMessage`, `OutboxMessage`, `IntegrationEvent`, ports, `PublishOutboxBatch`, backoff | Dev B | T01 | 5 |
| T05 | `WagerTransaction`, transições, policies, `ReferenceResolver`, `WagerSettlement` | Dev A | T03 | 4 |
| T06 | Use cases com fakes: `ProcessWagerTransaction`, idempotência, hash, `WagerOutcomeEvents`, wallet use cases, `RetryPendingReferences` | Dev B | T04, T05 | 6 |
| T07a | Schema: migrations, constraints, índices parciais e triggers, testados no PG real | Dev B | T02 | 7 |
| T07b | Persistência: mappers, repositórios, UoW, contratos, atomicidade, races 2×80 e 50 paralelos | Dev A | T06, T07a | 7 |
| T08 | HTTP Nest: controllers, filter, status table-driven, cursor, reconciliação, auth no-op, Swagger/OpenAPI em `/docs`, envelope + i18n conforme `docs/http-contract.md` | Dev B | T07 | 8 |
| T09 | SQS consumer: inbox, DLQ explícita, circuit breaker, SIGTERM, crash commit→ack | Dev A | T08 | 9 |
| T10 | Outbox publisher + worker de pendências | Dev B | T08 | 10 |
| T11 | Observabilidade: decorators, logs pino+ALS, `/metrics`, Grafana | Dev B | T09, T10 | 11 |
| T12 | Harness multi-instância (≥3), `docker pause`, cenário de reinício | Dev A | T11 | 12 |
| T13 | Carga k6 + nginx + `docs/load-test.md` | Dev B | T12 | 13 |
| T14 | Keycloak (profile `auth`) + adapter JWKS | Dev A | T12 | 14 |
| T15 | OTel opcional por decorators | Dev B | T13 | 15 |
| T16 | `README.md` + `ARCHITECTURE.md` em PT-BR | Tech lead + Dev A | todas | 16 |

## Critérios de aceite comuns (Definition of Done)

- `bun run lint`, `bun run typecheck`, `bun run test:arch` e `bun test` verdes;
- suítes de integração/concorrência da task verdes contra PG e LocalStack **reais**;
- nenhum `number` para dinheiro (lint bloqueia `parseFloat`, `Number(`, `toFixed`);
- `business/` sem import externo;
- `assertWalletConsistency` no `afterEach` das suítes que tocam wallet;
- commit com autor `cadu.oliveira2444@gmail.com`.
