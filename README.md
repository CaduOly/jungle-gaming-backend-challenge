# Distributed Wagering Processor

Este serviço é a carteira de um cassino online. Os jogos ficam com os provedores (estúdios de slot, mesa ao vivo etc.), e a cada rodada o provedor avisa o que aconteceu com o dinheiro do jogador: `BET` debita, `WIN` credita, `LOSS` só registra, `REFUND` devolve uma aposta e `ROLLBACK` desfaz uma operação anterior. O aviso chega por HTTP (`POST /wagering/transactions`) ou pela fila `wager-transactions.fifo`, os dois canais caem no mesmo use case, e o serviço mantém o saldo, um ledger imutável e publica os eventos de integração em `wagering-events.fifo` por um transactional outbox.

O enunciado completo está em [`docs/CHALLENGE.md`](docs/CHALLENGE.md), e as decisões, trade-offs e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stack

| Item | Versão |
| --- | --- |
| Runtime | Bun 1.4 (imagem `oven/bun:1.4.4-alpine`) |
| Linguagem | TypeScript strict: checagem de tipos no compilador nativo 7.0 e lint com o parser do 6.0 (ver `ARCHITECTURE.md`) |
| HTTP | NestJS 12, isolado em `src/infrastructure/framework/nest` |
| ORM | MikroORM 7 (PostgreSQL) |
| Banco | PostgreSQL 17.6 |
| Fila | SQS FIFO, local no LocalStack 4.4.0 |
| Auth | no-op por padrão, Keycloak 26.3 + `jose` (JWKS) no profile `auth` |
| Observabilidade | pino (logs JSON), prom-client, Prometheus 3.5 e Grafana 12.1 |
| Carga | k6 + nginx na frente de 3 réplicas |
| Arquitetura | dependency-cruiser (`bun run test:arch`) |

## Setup

Precisa de Docker com o plugin `compose` e do Bun instalado.

```bash
bun install
cp .env.example .env
```

O `.env.example` traz todos os parâmetros com o valor padrão e um comentário de cada um. As portas do host são configuráveis (`POSTGRES_HOST_PORT=55432`, `LOCALSTACK_HOST_PORT=4566`, `APP_HOST_PORT=8080`, `GRAFANA_HOST_PORT=3001`, `PROMETHEUS_HOST_PORT=9090`, `KEYCLOAK_HOST_PORT=8081`) para não brigar com outro stack na máquina.

## Comandos

### Infra (PostgreSQL + LocalStack)

```bash
bun run infra:up      # docker compose up -d --wait postgres localstack
bun run infra:down
```

O LocalStack sobe com o `infra/localstack/init-sqs.sh`, que cria as filas FIFO `wager-transactions.fifo` e `wagering-events.fifo`, cada uma com a sua DLQ (`wager-transactions-dlq.fifo` e `wagering-events-dlq.fifo`) e redrive. O healthcheck só fica verde quando o init terminou com sucesso e as filas existem com o `RedrivePolicy` certo.

### Migrations

```bash
bun run migrate         # up
bun run migrate:down    # desfaz a última
```

A aplicação não roda migration sozinha, então isso vem antes da primeira réplica subir. No `docker-compose.app.yml` existe o serviço `migrate`, que roda uma vez antes das réplicas.

### Aplicação local

```bash
bun run start
```

Sobe em `http://localhost:3000` com todos os papéis (`APP_ROLES=api,consumer,outbox,pending-worker`).

### Aplicação com 3 réplicas + nginx

```bash
bun run infra:up
docker compose -f docker-compose.app.yml up -d --build
```

O `docker-compose.app.yml` entra na rede do stack de infra (`jungle-wagering_default`), roda o `migrate`, sobe o serviço `app` com **3 réplicas** (1 CPU e 512 MB cada, `stop_grace_period: 30s`) e o nginx na frente, em `http://localhost:8080`. A mesma imagem roda todos os papéis, e cada réplica responde com o header `X-Instance-Id`.

### Observabilidade

O `docker-compose.app.yml` já inclui o `docker-compose.observability.yml`, então o Prometheus e o Grafana sobem junto com as réplicas:

- Grafana: `http://localhost:3001`, com o datasource e o dashboard `wagering` provisionados (viewer anônimo, `admin`/`admin` para editar);
- Prometheus: `http://localhost:9090`, raspando o `/metrics` de cada réplica.

Para subir só os dois por cima de um stack que já está de pé:

```bash
docker compose -f docker-compose.observability.yml up -d
```

### Auth (profile `auth`)

Por padrão a API roda com `AUTH_MODE=noop`, que aceita `Authorization: Bearer dev:<providerId>` e não prova nada sobre quem chamou. Para usar o Keycloak de verdade:

```bash
AUTH_MODE=jwks docker compose -f docker-compose.app.yml --profile auth up -d --build
```

O Keycloak sobe em `http://localhost:8081` com o realm `wagering` e um client confidencial por provedor (`provider-a` e `provider-b`, segredo `<client>-secret`), cada token carregando a claim `provider_id` e a audience `wagering-api`.

```bash
curl -s -X POST http://localhost:8081/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret
```

### Exemplo rápido

```bash
curl -s -X POST http://localhost:8080/wallets \
  -H 'Authorization: Bearer dev:provider-a' -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -s -X POST http://localhost:8080/wagering/transactions \
  -H 'Authorization: Bearer dev:provider-a' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Dinheiro sempre entra e sai como string com duas casas (`"25.00"`). Número JSON, `"25.5"` ou `"1e2"` voltam 400.

## Links

- `GET /docs`: Swagger UI, com a spec OpenAPI 3 em `GET /docs-json`. Toda rota documenta o sucesso e todos os erros possíveis.
- `GET /i18n`: catálogo completo das chaves de mensagem, para o front montar as traduções. É aberto.
- `GET /health/live` e `GET /health/ready`: abertos, sem envelope. O ready confere PostgreSQL e SQS.
- `GET /metrics`: formato Prometheus.
- [`docs/http-contract.md`](docs/http-contract.md): envelope, catálogo i18n e a tabela erro → status.
- [`docs/load-test.md`](docs/load-test.md): relatório da carga.
- [`docs/test-infra.md`](docs/test-infra.md): isolamento das suítes no stack compartilhado e o sweep.
- [`docs/spikes/localstack.md`](docs/spikes/localstack.md): validação do LocalStack sem token e do redrive FIFO.

## Testes

Todas as suítes que falam com banco ou fila rodam contra o PostgreSQL e o LocalStack **reais** do `bun run infra:up`, nunca contra mock. Cada execução cria o próprio banco `wagering_test_<uuidv7>` e as próprias filas `wager-transactions[-dlq]-<uuidv7>.fifo` e `wagering-events[-dlq]-<uuidv7>.fifo`, então dá para rodar em paralelo com outra pessoa usando o mesmo stack.

| Comando | O que roda |
| --- | --- |
| `bun run lint` | ESLint, incluindo o bloqueio de `parseFloat`, `Number(` e `toFixed` no código de dinheiro |
| `bun run typecheck` | `tsc --noEmit` com o TypeScript 7 nativo |
| `bun run test` | unitários de `src`, specs de fakes, contratos e builders em `tests/support`, e o e2e HTTP em memória |
| `bun run test:arch` | dependency-cruiser + regras de arquitetura (business sem import externo, Nest só em `framework/nest` etc.) |
| `bun run test:integration` | schema, triggers, repositórios, UoW, outbox, consumer SQS, worker de pendências e redrive, no PG e no LocalStack |
| `bun run test:concurrency` | races (2 × 80.00 sobre 100.00, 50 BETs paralelas, mesma key em wallets diferentes, worker de pendências), com `--rerun-each ${RERUN_EACH:-20}` |
| `bun run test:multi` | 3 processos da aplicação de verdade, carga mista, `kill -9` em todos, restart e reconciliação de todas as wallets |
| `bun run test:chaos` | `docker pause` no PostgreSQL compartilhado com 3 réplicas rodando: 503 + `Retry-After`, `/health/ready` fora, breaker abrindo e a fila processada quando o banco volta |
| `bun run test:load` | k6 contra nginx + 3 réplicas, nos cenários distribuído, hot wallet, mix com duplicatas e caminho SQS, com reconciliação no fim |
| `bun run test:auth` | smoke do Keycloak: um `provider_id` por client, segredo errado recusado no IdP, token adulterado e token `dev:` em 401 |

O `test:chaos` pausa o container do PostgreSQL que todo mundo usa, então ele **roda sozinho**, nunca junto com outra suíte nem com outra pessoa testando no mesmo stack. O `test:auth` precisa do Keycloak de pé (`docker compose -f docker-compose.auth.yml --profile auth up -d --wait`).

Se um processo de teste morrer antes do cleanup, sobram bancos e filas, e o `bun run test:sweep` limpa o que tem mais de 30 minutos (`--help` mostra as opções). O sweep só olha a idade, então com alguém rodando uma suíte longa no mesmo stack vale passar um `--older-than-minutes` maior que a duração dela.
