# Jungle Wagering

A carteira de um cassino online. Os jogos ficam com os provedores, e a cada rodada o provedor avisa o que aconteceu com o dinheiro do jogador: `BET` debita, `WIN` credita, `LOSS` só registra, `REFUND` devolve uma aposta e `ROLLBACK` desfaz uma operação anterior. O aviso chega por HTTP (`POST /wagering/transactions`) ou pela fila `wager-transactions.fifo`, os dois canais caem no mesmo use case, e o serviço mantém o saldo, um ledger imutável e publica os eventos em `wagering-events.fifo` por um transactional outbox.

O enunciado está em [`docs/CHALLENGE.md`](docs/CHALLENGE.md), e as decisões, trade-offs e limitações estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Pré-requisitos

| Ferramenta | Versão | Para quê |
| --- | --- | --- |
| Docker + plugin `compose` | Compose v2 com suporte a `include` (2.20 ou mais novo) | Infra, réplicas, nginx, Prometheus, Grafana e Keycloak |
| Bun | 1.4 | Rodar a aplicação fora do Docker, as migrations e os testes |
| AWS CLI ou `awslocal` | qualquer v2 | Só para mandar mensagem na fila à mão |
| k6 | qualquer recente | Só para `bun run test:load` |

## Subir em 3 comandos

```bash
cp .env.example .env
bun run infra:up
docker compose -f docker-compose.app.yml up -d --build --wait
```

O primeiro sobe o PostgreSQL (porta `55432`) e o LocalStack (porta `4566`) com as filas criadas. O segundo builda a imagem, roda o `migrate` uma vez, sobe **3 réplicas** da aplicação, o nginx na frente, o Prometheus e o Grafana. Quando o `--wait` volta, está tudo de pé.

O serviço `migrate` pede o build com `network: host`, porque o `bun install` precisa do DNS do host para achar o registry do npm. Se o seu Docker não liberar esse privilégio (erro de `network.host` no build), builde a imagem à parte e suba sem build:

```bash
docker build --network host -t jungle-wagering-app:local .
docker compose -f docker-compose.app.yml up -d --no-build --wait
```

Para desligar:

```bash
docker compose -f docker-compose.app.yml down
bun run infra:down
```

## Onde acessar

| URL | Para que serve | Credencial |
| --- | --- | --- |
| <http://localhost:8080> | API, pelo nginx, balanceando entre as 3 réplicas. Cada resposta traz o header `X-Instance-Id` | `Authorization: Bearer dev:provider-a` |
| <http://localhost:8080/docs> | Swagger UI | Botão **Authorize** com o valor `dev:provider-a` |
| <http://localhost:8080/docs-json> | Spec OpenAPI 3 | aberto |
| <http://localhost:8080/i18n> | Catálogo de códigos e chaves de mensagem | aberto |
| <http://localhost:8080/health/live> e `/health/ready` | Liveness e readiness (PostgreSQL e SQS) | aberto |
| <http://localhost:8080/metrics> | Métricas Prometheus da réplica que respondeu | aberto |
| <http://localhost:3001/d/jungle-wagering> | Dashboard "Jungle Wagering" no Grafana | anônimo para ver, `admin`/`admin` para editar |
| <http://localhost:9090> | Prometheus, raspando o `/metrics` de cada réplica | aberto |
| <http://localhost:8081> | Keycloak, só no profile `auth` | `admin`/`admin` no console |
| `localhost:55432` | PostgreSQL | `wagering`/`wagering`, banco `wagering` |
| <http://localhost:4566> | LocalStack (SQS) | qualquer chave estática, por exemplo `test`/`test` |

As portas do host saem do `.env` (`APP_HOST_PORT`, `GRAFANA_HOST_PORT`, `PROMETHEUS_HOST_PORT`, `KEYCLOAK_HOST_PORT`, `POSTGRES_HOST_PORT`, `LOCALSTACK_HOST_PORT`), então dá para trocar qualquer uma se já estiver ocupada.

## Primeira chamada

Cada exemplo vem em quatro partes: requisição, headers, body e resposta esperada. Assim dá para montar a chamada no Postman, no Insomnia ou no curl. As respostas foram copiadas da API rodando.

Para não montar nada à mão, importe <http://localhost:8080/docs-json> no Postman ou no Insomnia. A coleção sai com todas as rotas e exemplos.

Os valores fixos do passo a passo:

| Nome | Valor |
| --- | --- |
| `playerId` | `0192f28f-5dc0-7d58-bdb2-814ad6a0f4b7` |
| `walletId` | `01a18aac-a369-76a8-aae1-b810fb3e7959` (o seu vai ser outro) |
| Token | `Bearer dev:provider-a` |

O `walletId` é gerado pela API no passo 1. Nos passos seguintes, troque `01a18aac-a369-76a8-aae1-b810fb3e7959` pelo id que voltou na sua chamada.

No curl, deixe as variáveis prontas:

```bash
API=http://localhost:8080
AUTH='Authorization: Bearer dev:provider-a'
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4b7
```

### 1. Criar a wallet com 100.00

**Requisição:** `POST http://localhost:8080/wallets`

**Headers**

| Header | Valor |
| --- | --- |
| `Authorization` | `Bearer dev:provider-a` |
| `Content-Type` | `application/json` |

**Body**

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4b7",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

**Resposta esperada:** `201 Created`

```json
{
  "code": 201,
  "message": "CREATED",
  "data": {
    "id": "01a18aac-a369-76a8-aae1-b810fb3e7959",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4b7",
    "balance": { "amount": "100.00", "currency": "BRL" },
    "version": 1
  },
  "timestamp": 1793327932268,
  "detailsMessage": []
}
```

Guarde o `data.id`. Uma segunda wallet para o mesmo jogador e moeda volta `409`.

**curl**

```bash
curl -s -X POST $API/wallets -H "$AUTH" -H 'Content-Type: application/json' -d @- <<EOF
{ "playerId": "$PLAYER", "initialBalance": { "amount": "100.00", "currency": "BRL" } }
EOF
WALLET=01a18aac-a369-76a8-aae1-b810fb3e7959   # o id que voltou
```

### 2. Apostar 25.00

**Requisição:** `POST http://localhost:8080/wagering/transactions`

**Headers**

| Header | Valor |
| --- | --- |
| `Authorization` | `Bearer dev:provider-a` |
| `Content-Type` | `application/json` |
| `Idempotency-Key` | `provider-a:tx-1` |

**Body**

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "tx-1",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4b7",
  "walletId": "01a18aac-a369-76a8-aae1-b810fb3e7959",
  "roundId": "round-1",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

**Resposta esperada:** `200 OK`

```json
{
  "code": 200,
  "message": "SUCCESS",
  "data": {
    "transactionId": "01a18aac-a378-747c-8bb4-46a87a792c6e",
    "status": "PROCESSED",
    "balance": { "amount": "75.00", "currency": "BRL" },
    "idempotentReplay": false
  },
  "timestamp": 1793327932284,
  "detailsMessage": []
}
```

**curl**

```bash
curl -s -X POST $API/wagering/transactions -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' -d @- <<EOF
{ "providerId": "provider-a", "externalTransactionId": "tx-1", "playerId": "$PLAYER",
  "walletId": "$WALLET", "roundId": "round-1", "gameId": "fortune-chimp",
  "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" } }
EOF
```

### 3. Repetir a mesma chamada (replay idempotente)

**Requisição:** `POST http://localhost:8080/wagering/transactions`

**Headers:** os mesmos do passo 2, com `Idempotency-Key: provider-a:tx-1`.

**Body:** o mesmo do passo 2, sem mudar nada.

**Resposta esperada:** `200 OK`. O saldo não muda e volta a decisão original com `idempotentReplay: true`.

```json
{
  "code": 200,
  "message": "SUCCESS",
  "data": {
    "transactionId": "01a18aac-a378-747c-8bb4-46a87a792c6e",
    "status": "PROCESSED",
    "balance": { "amount": "75.00", "currency": "BRL" },
    "idempotentReplay": true
  },
  "timestamp": 1793327932293,
  "detailsMessage": []
}
```

**curl:** o mesmo comando do passo 2.

### 4. Mesma key com outro corpo (conflito)

**Requisição:** `POST http://localhost:8080/wagering/transactions`

**Headers:** os mesmos do passo 2, com `Idempotency-Key: provider-a:tx-1`.

**Body:** o do passo 2 com `"money": { "amount": "30.00", "currency": "BRL" }`.

**Resposta esperada:** `409 Conflict`. Nada é gravado.

```json
{
  "code": 409,
  "message": "CONFLICT",
  "data": { "existingTransactionId": "01a18aac-a378-747c-8bb4-46a87a792c6e" },
  "timestamp": 1793327932304,
  "detailsMessage": [
    { "code": "IDEMPOTENCY_CONFLICT", "message": "WAGERING.ERROR.IDEMPOTENCY_CONFLICT", "type": "error" }
  ]
}
```

**curl**

```bash
curl -s -X POST $API/wagering/transactions -H "$AUTH" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' -d @- <<EOF
{ "providerId": "provider-a", "externalTransactionId": "tx-1", "playerId": "$PLAYER",
  "walletId": "$WALLET", "roundId": "round-1", "gameId": "fortune-chimp",
  "kind": "BET", "money": { "amount": "30.00", "currency": "BRL" } }
EOF
```

### 5. Consultar o saldo

**Requisição:** `GET http://localhost:8080/wallets/01a18aac-a369-76a8-aae1-b810fb3e7959`

**Headers**

| Header | Valor |
| --- | --- |
| `Authorization` | `Bearer dev:provider-a` |

**Body:** nenhum.

**Resposta esperada:** `200 OK`

```json
{
  "code": 200,
  "message": "SUCCESS",
  "data": {
    "id": "01a18aac-a369-76a8-aae1-b810fb3e7959",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4b7",
    "balance": { "amount": "75.00", "currency": "BRL" },
    "version": 2
  },
  "timestamp": 1793327932311,
  "detailsMessage": []
}
```

**curl**

```bash
curl -s $API/wallets/$WALLET -H "$AUTH"
```

### 6. Consultar o extrato

**Requisição:** `GET http://localhost:8080/wallets/01a18aac-a369-76a8-aae1-b810fb3e7959/ledger?limit=50`

**Headers**

| Header | Valor |
| --- | --- |
| `Authorization` | `Bearer dev:provider-a` |

**Body:** nenhum.

**Resposta esperada:** `200 OK`. Os lançamentos vêm do mais antigo para o mais novo. A próxima página sai em `data.nextCursor`, que é `null` quando acabou.

```json
{
  "code": 200,
  "message": "SUCCESS",
  "data": {
    "walletId": "01a18aac-a369-76a8-aae1-b810fb3e7959",
    "entries": [
      {
        "transactionId": "01a18aac-a369-76a9-b788-621ed61816b4",
        "entryType": "OPENING",
        "direction": "CREDIT",
        "amount": { "amount": "100.00", "currency": "BRL" },
        "balanceBefore": { "amount": "0.00", "currency": "BRL" },
        "balanceAfter": { "amount": "100.00", "currency": "BRL" },
        "walletVersion": 1,
        "createdAt": "2026-10-30T02:38:52.265Z"
      },
      {
        "transactionId": "01a18aac-a378-747c-8bb4-46a87a792c6e",
        "entryType": "BET",
        "direction": "DEBIT",
        "amount": { "amount": "25.00", "currency": "BRL" },
        "balanceBefore": { "amount": "100.00", "currency": "BRL" },
        "balanceAfter": { "amount": "75.00", "currency": "BRL" },
        "walletVersion": 2,
        "createdAt": "2026-10-30T02:38:52.281Z"
      }
    ],
    "nextCursor": null
  },
  "timestamp": 1793327932320,
  "detailsMessage": []
}
```

**curl**

```bash
curl -s "$API/wallets/$WALLET/ledger?limit=50" -H "$AUTH"
```

### 7. Reconciliar

**Requisição:** `POST http://localhost:8080/wallets/01a18aac-a369-76a8-aae1-b810fb3e7959/reconciliation`

**Headers**

| Header | Valor |
| --- | --- |
| `Authorization` | `Bearer dev:provider-a` |

**Body:** nenhum.

**Resposta esperada:** `200 OK`. A reconciliação só relata, nunca corrige.

```json
{
  "code": 200,
  "message": "SUCCESS",
  "data": {
    "walletId": "01a18aac-a369-76a8-aae1-b810fb3e7959",
    "storedBalance": { "amount": "75.00", "currency": "BRL" },
    "calculatedBalance": { "amount": "75.00", "currency": "BRL" },
    "difference": { "amount": "0.00", "currency": "BRL" },
    "consistent": true,
    "checkedEntries": 2
  },
  "timestamp": 1793327932331,
  "detailsMessage": []
}
```

**curl**

```bash
curl -s -X POST $API/wallets/$WALLET/reconciliation -H "$AUTH"
```

### 8. Health

**Requisição:** `GET http://localhost:8080/health/live` e `GET http://localhost:8080/health/ready`

**Headers:** nenhum. As duas rotas são abertas.

**Body:** nenhum.

**Resposta esperada:** `200 OK`. O `/health/live` responde `{"status":"ok"}`. O `/health/ready` responde `503` se o PostgreSQL ou o SQS estiver fora.

```json
{
  "instanceId": "9f91e09fec19-1",
  "roles": ["api", "consumer", "outbox", "pending-worker"],
  "circuitBreaker": "closed",
  "status": "ready",
  "checks": { "postgres": "up", "sqs": "up" }
}
```

**curl**

```bash
curl -s $API/health/live
curl -s $API/health/ready
```

**Corrida de verdade.** Numa wallet nova com 100.00, duas BETs de 80.00 em paralelo (keys diferentes) dão uma `200` e uma `422` com `INSUFFICIENT_FUNDS`, o saldo fica em 20.00 e a reconciliação volta `consistent: true`.

Dinheiro sempre entra e sai como string com duas casas (`"25.00"`). Número JSON, `"25.5"` ou `"1e2"` voltam `400`. O envelope, o catálogo i18n e a tabela erro → status estão em [`docs/http-contract.md`](docs/http-contract.md).

## Autenticação

**Dev (padrão).** Com `AUTH_MODE=noop` a API aceita `Authorization: Bearer dev:<providerId>`. Não prova nada sobre quem chamou, serve para desenvolvimento. O provedor do token é quem está agindo: se o `providerId` do corpo ou do caminho for outro, a resposta é `403 PROVIDER_IDENTITY_MISMATCH`.

No Swagger, o esquema é `http`/`bearer`, então o Swagger UI coloca o prefixo `Bearer` sozinho. No **Authorize** informe só `dev:provider-a`, sem o prefixo.

**Keycloak (profile `auth`).** Suba as réplicas validando JWT pelo JWKS do Keycloak:

```bash
AUTH_MODE=jwks docker compose -f docker-compose.app.yml --profile auth up -d --build --wait
```

O Keycloak sobe em <http://localhost:8081> com o realm `wagering` e um client confidencial por provedor (`provider-a` e `provider-b`, segredo `<client>-secret`). Cada token traz a claim `provider_id` e a audience `wagering-api`.

```bash
TOKEN=$(curl -s -X POST http://localhost:8081/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | jq -r .access_token)

curl -s $API/wallets/$WALLET -H "Authorization: Bearer $TOKEN"
```

Nesse modo o token `dev:` volta `401`. Para voltar ao modo dev, suba de novo sem o `AUTH_MODE=jwks`.

## Enviar pela fila SQS

A fila de comandos é `wager-transactions.fifo`. O corpo é um envelope `WagerTransactionRequested` com o mesmo payload da API em `data`, mais o `idempotencyKey`. Chave fora do contrato, tipo errado ou `kind: OPENING` mandam a mensagem para a `wager-transactions-dlq.fifo`. HTTP e fila dividem a idempotência, então a mesma operação mandada pelos dois canais tem um efeito só.

**Fila e endpoint**

| Item | Valor |
| --- | --- |
| Endpoint | `http://localhost:4566` (LocalStack, região `us-east-1`, chaves `test`/`test`) |
| Fila | `wager-transactions.fifo` |
| URL da fila | `http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo` |

**Atributos da mensagem**

| Atributo | Valor | Para que serve |
| --- | --- | --- |
| `MessageGroupId` | `01a18aac-a369-76a8-aae1-b810fb3e7959` | O `walletId`. Mantém a ordem por wallet |
| `MessageDeduplicationId` | `tx-sqs-1` | Deduplicação da própria fila FIFO |
| `providerId` (atributo `String`) | `provider-a` | O provedor que age. Sem ele, vale o `actorProviderId` do envelope ou o `data.providerId` |

**Body**

Troque o `walletId` (e o `MessageGroupId`) pelo id devolvido no passo 1 da primeira chamada.

```json
{
  "messageId": "tx-sqs-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-29T12:00:00Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "tx-sqs-1",
    "idempotencyKey": "provider-a:tx-sqs-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4b7",
    "walletId": "01a18aac-a369-76a8-aae1-b810fb3e7959",
    "roundId": "round-2",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "5.00", "currency": "BRL" }
  }
}
```

**Comando `aws`**

```bash
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
QUEUE=$(aws --endpoint-url http://localhost:4566 sqs get-queue-url \
  --queue-name wager-transactions.fifo --query QueueUrl --output text)

BODY=$(cat <<EOF
{ "messageId": "tx-sqs-1", "type": "WagerTransactionRequested", "occurredAt": "2026-10-29T12:00:00Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "tx-sqs-1",
    "idempotencyKey": "provider-a:tx-sqs-1", "playerId": "$PLAYER", "walletId": "$WALLET",
    "roundId": "round-2", "gameId": "fortune-chimp", "kind": "BET",
    "money": { "amount": "5.00", "currency": "BRL" } } }
EOF
)

aws --endpoint-url http://localhost:4566 sqs send-message --queue-url "$QUEUE" \
  --message-group-id "$WALLET" --message-deduplication-id tx-sqs-1 \
  --message-attributes '{"providerId":{"DataType":"String","StringValue":"provider-a"}}' \
  --message-body "$BODY"
```

Com o `awslocal` é o mesmo comando sem o `--endpoint-url`. A fila responde com o `MessageId` e o `SequenceNumber`.

**Conferir o resultado**

**Requisição:** `GET http://localhost:8080/providers/provider-a/wagering/transactions/tx-sqs-1`

**Headers:** `Authorization: Bearer dev:provider-a`.

**Resposta esperada:** `200 OK`, com `status: PROCESSED` e o saldo depois da aposta.

```json
{
  "code": 200,
  "message": "SUCCESS",
  "data": {
    "transactionId": "01a18aac-ceb5-752f-8e63-b0f04d5411b8",
    "providerId": "provider-a",
    "externalTransactionId": "tx-sqs-1",
    "walletId": "01a18aac-a369-76a8-aae1-b810fb3e7959",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4b7",
    "roundId": "round-2",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "5.00", "currency": "BRL" },
    "status": "PROCESSED",
    "failureCode": null,
    "referenceExternalTransactionId": null,
    "referenceTransactionId": null,
    "balance": { "amount": "70.00", "currency": "BRL" },
    "attempts": 0,
    "nextAttemptAt": null,
    "createdAt": "2026-10-30T02:39:03.350Z",
    "processedAt": "2026-10-30T02:39:03.350Z"
  },
  "timestamp": 1793327943443,
  "detailsMessage": []
}
```

**curl**

```bash
curl -s $API/providers/provider-a/wagering/transactions/tx-sqs-1 -H "$AUTH"
```

## Observabilidade

**Health.** `GET /health/live` responde `200 {"status":"ok"}` enquanto o processo está de pé. `GET /health/ready` confere o PostgreSQL (`SELECT 1`) e o SQS (`GetQueueAttributes`) e volta `503` com o nome de quem caiu. Os dois são abertos e respondem sem envelope.

**Logs.** JSON pelo pino, um por linha, com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` quando existem. Payload financeiro completo e token não vão para o log. Para ver: `docker compose -f docker-compose.app.yml logs -f app`.

**Métricas.** `GET /metrics` no formato Prometheus. As principais:

| Métrica | O que mede |
| --- | --- |
| `wager_transactions_total` | transações decididas, por `status` e `kind` |
| `idempotent_duplicates_total` | replays e duplicatas detectadas |
| `retries_total` | retentativas (consumer, outbox, worker de pendências) |
| `dlq_messages_total` | mensagens mandadas para a DLQ, com o motivo |
| `lock_conflicts_total` e `lock_wait_seconds` | lock timeout, deadlock e espera pelo lock da wallet |
| `outbox_lag_seconds` | tempo entre o commit do evento e a publicação |
| `processing_duration_seconds` | latência de processamento |
| `reconciliation_divergences_total` | divergências achadas na reconciliação |
| `circuit_breaker_open` | breaker aberto por réplica |

O dashboard "Jungle Wagering" do Grafana (<http://localhost:3001/d/jungle-wagering>) já vem com esses painéis.

## Teste de carga

`bun run test:load` sobe o k6 contra o nginx e as 3 réplicas, nos cenários distribuído, hot wallet, mix com duplicatas e caminho SQS, e reconcilia todas as wallets no fim. O relatório em [`docs/load-test.md`](docs/load-test.md) traz o ambiente, a metodologia, o throughput, p50/p95/p99, a taxa de erro, os conflitos de lock e o outbox lag. Precisa do k6 e do stack de pé.

## Rodar fora do Docker

```bash
bun install
bun run infra:up
bun run migrate         # a aplicação não roda migration sozinha
bun run start           # http://localhost:3000, com todos os papéis
```

`bun run migrate:down` desfaz a última migration. Os papéis do processo saem de `APP_ROLES` (`api`, `consumer`, `outbox`, `pending-worker`).

## Testes

Todas as suítes que falam com banco ou fila rodam contra o PostgreSQL e o LocalStack **reais** do `bun run infra:up`, nunca contra mock. Cada execução cria o próprio banco `wagering_test_<uuidv7>` e as próprias filas `wager-transactions[-dlq]-<uuidv7>.fifo` e `wagering-events[-dlq]-<uuidv7>.fifo`, então dá para rodar em paralelo com outra pessoa no mesmo stack.

| Comando | O que prova |
| --- | --- |
| `bun run lint` | ESLint, incluindo o bloqueio de `parseFloat`, `Number(` e `toFixed` no código de dinheiro |
| `bun run typecheck` | `tsc --noEmit` com o TypeScript 7 nativo |
| `bun run test` | unitários de `src`, specs de fakes, contratos e builders em `tests/support`, e o e2e HTTP em memória |
| `bun run test:arch` | dependency-cruiser + regras de arquitetura (business sem import externo, Nest só em `framework/nest` etc.) |
| `bun run test:integration` | schema, triggers, repositórios, UoW, outbox, consumer SQS, worker de pendências e redrive, no PG e no LocalStack |
| `bun run test:concurrency` | races (2 × 80.00 sobre 100.00, 50 BETs paralelas, mesma key em wallets diferentes, worker de pendências), com `--rerun-each ${RERUN_EACH:-20}` |
| `bun run test:multi` | 3 processos da aplicação de verdade, carga mista, `kill -9` em todos, restart e reconciliação de todas as wallets |
| `bun run test:chaos` | `docker pause` no PostgreSQL com 3 réplicas rodando: 503 + `Retry-After`, `/health/ready` fora, breaker abrindo e a fila processada quando o banco volta |
| `bun run test:load` | k6 contra nginx + 3 réplicas, nos cenários distribuído, hot wallet, mix com duplicatas e caminho SQS, com reconciliação no fim |
| `bun run test:auth` | smoke do Keycloak: um `provider_id` por client, segredo errado recusado no IdP, token adulterado e token `dev:` em 401 |

### O que cada teste obrigatório cobre

| Teste do enunciado (§13) | Suíte | Arquivo |
| --- | --- | --- |
| `Money`: escala, arredondamento, entradas inválidas | `test` | `src/business/shared/value-object/money.spec.ts` |
| Invariantes da `Wallet` | `test` | `src/business/wallet/entity/wallet.spec.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK | `test` | `src/business/wagering/domain-service/wager-rules.spec.ts`, `reversal.policy.spec.ts`, `process-wager-transaction.spec.ts` |
| Conflito de moeda | `test`, `test:integration` | `money.spec.ts`, `reference-resolver.spec.ts`, `tests/integration/wagering/real-flow.spec.ts` |
| Idempotency key com payload divergente | `test`, `test:integration` | `src/business/wagering/domain-service/idempotency-check.spec.ts`, `real-flow.spec.ts` |
| Migrations e constraints | `test:integration` | `tests/integration/persistence/migrations.spec.ts`, `*-schema.spec.ts` |
| Atomicidade wallet, ledger, inbox e outbox | `test:integration` | `tests/integration/persistence/unit-of-work.spec.ts`, `tests/integration/wagering/real-flow.spec.ts` (falha injetada no ledger, na outbox e antes do commit) |
| Inbox e redelivery | `test:integration` | `tests/integration/wagering/sqs-wagering.spec.ts`, `tests/integration/persistence/messaging-concurrency.spec.ts` |
| Publishers concorrentes sobre a mesma outbox | `test:integration` | `tests/integration/messaging/outbox-publisher.spec.ts`, `messaging-concurrency.spec.ts` |
| Retry e DLQ | `test:integration` | `tests/integration/messaging/sqs-consumer.spec.ts`, `tests/integration/infra/sqs-redrive.spec.ts` |
| Recuperação após reinicialização | `test:integration`, `test:multi` | `outbox-publisher.spec.ts` (SIGKILL entre publish e mark), `tests/multi-instance/restart.spec.ts` |
| 1. Mesma aposta 50 vezes em paralelo | `test:concurrency` | `tests/concurrency/wagering/wager-races.spec.ts` |
| 2. Disputa de saldo na mesma wallet (2 × 80.00) | `test:concurrency` | `wager-races.spec.ts` |
| 3. Wallets distintas em paralelo | `test:concurrency` | `wager-races.spec.ts` |
| 4. ≥ 3 processos simultâneos | `test:multi` | `tests/multi-instance/mixed-load.spec.ts` |
| 5. Worker morto depois do commit e antes do ack | `test:integration` | `sqs-wagering.spec.ts`, `sqs-consumer.spec.ts` (`crash_after_commit_before_ack`) |
| 6. Dois publishers sobre a mesma outbox | `test:integration` | `outbox-publisher.spec.ts` (3 workers em pools separados) |
| 7. ROLLBACK ou REFUND antes da referência | `test:integration`, `test:concurrency` | `real-flow.spec.ts`, `tests/concurrency/wagering/pending-worker-races.spec.ts` |
| 8. Reinício com consistência final | `test:multi` | `restart.spec.ts` (`kill -9` em todas as réplicas e reconciliação) |

A invariante `wallet.balance == saldo reconstruído pelo ledger` é conferida pela reconciliação de todas as wallets no fim do `test:multi` e do `test:load`, e pelo `tests/support/assert-wallet-consistency.ts` nos testes de repositório. Nas races do `test:concurrency` a conferência é o saldo final e a contagem de lançamentos no ledger.

O `test:chaos` pausa o container do PostgreSQL que todo mundo usa, então ele **roda sozinho**, nunca junto com outra suíte nem com outra pessoa no mesmo stack. O `test:auth` precisa do Keycloak de pé (`docker compose -f docker-compose.auth.yml --profile auth up -d --wait`).

Todas as suítes rodam contra o mesmo stack do compose sem se atrapalhar: cada execução cria um banco `wagering_test_<uuidv7>` e filas com o mesmo sufixo (`tests/support/test-database.ts` e `test-queues.ts`), e apaga tudo no fim.

Se um processo de teste morrer antes do cleanup, sobram bancos e filas, e o `bun run test:sweep` limpa o que tem mais de 30 minutos (`--help` mostra as opções). O sweep só olha a idade, então com alguém rodando uma suíte longa no mesmo stack passe um `--older-than-minutes` maior que a duração dela.

## Configuração

O `.env.example` traz todos os parâmetros com o valor padrão e um comentário de cada um. Os principais:

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:55432/wagering` | Conexão com o PostgreSQL |
| `APP_ROLES` | `api,consumer,outbox,pending-worker` | Papéis do processo (vazio = todos) |
| `PORT` | `3000` | Porta HTTP do processo |
| `AUTH_MODE` | `noop` | `noop` aceita `dev:<providerId>`, `jwks` valida JWT do Keycloak |
| `SQS_ENDPOINT` | `http://localhost:${LOCALSTACK_HOST_PORT}` | Endpoint do SQS |
| `SQS_COMMANDS_QUEUE_NAME` | `wager-transactions.fifo` | Fila de comandos |
| `SQS_EVENTS_QUEUE_NAME` | `wagering-events.fifo` | Fila de eventos |
| `HTTP_REQUEST_TIMEOUT_MS` | `10000` | Teto de uma requisição, depois vira 503 + `Retry-After` |
| `DB_LOCK_TIMEOUT_MS` | `2000` | `lock_timeout` de cada unit of work |
| `LOG_LEVEL` | `info` | Nível do pino |

## Troubleshooting

| Sintoma | Causa e saída |
| --- | --- |
| Build falha com erro de `network.host` ou o `bun install` não resolve o registry | O compose pede o build com rede do host. Builde à parte com `docker build --network host -t jungle-wagering-app:local .` e suba com `up -d --no-build --wait` |
| `network jungle-wagering_default not found` | O `docker-compose.app.yml` entra na rede do stack de infra. Rode `bun run infra:up` antes |
| `port is already allocated` | Outra coisa usa a porta. Troque a porta no `.env` (`APP_HOST_PORT`, `GRAFANA_HOST_PORT`, `POSTGRES_HOST_PORT` etc.) e suba de novo |
| `/health/ready` com `sqs: down` ou o consumer reclamando de fila inexistente | O LocalStack não guarda estado, e um container antigo pode ter filas com nome antigo. Recrie: `docker compose up -d --force-recreate --wait localstack`. O init cria as filas de novo e o healthcheck só fica verde com elas no lugar |
| Token `dev:` volta 401 | As réplicas estão com `AUTH_MODE=jwks`. Use um token do Keycloak ou suba de novo sem essa variável |
| Mensagem da fila não aparece | Confira a `wager-transactions-dlq.fifo`: chave fora do contrato ou `kind: OPENING` vão direto para lá |
| Sobram bancos `wagering_test_*` e filas de teste | `bun run test:sweep` |

## Decisões documentadas

O enunciado pede que algumas escolhas fiquem justificadas. Onde está cada uma:

| Item do enunciado | Onde |
| --- | --- |
| §2 Auth: decisão, desenho e ponto de extensão | [`ARCHITECTURE.md` › Auth](ARCHITECTURE.md#auth) |
| §4 ORM, mapeamento do `Money` e estratégia transacional | [`ARCHITECTURE.md` › Persistência](ARCHITECTURE.md#persistência-mikroorm-money-e-a-transação) e [Dinheiro](ARCHITECTURE.md#dinheiro-bigint-e-nada-de-arredondamento) |
| §6 Transições válidas da `WagerTransaction` | [`ARCHITECTURE.md` › Transições e replay](ARCHITECTURE.md#wagertransaction-transições-e-replay) |
| §7 Interpretações adicionais das regras | [`ARCHITECTURE.md` › Referências](ARCHITECTURE.md#referências-refund--rollback) e [Desvios do enunciado](ARCHITECTURE.md#desvios-do-enunciado-e-limitações-conhecidas) |
| §7.2 Taxonomia do `failureCode` | [`ARCHITECTURE.md` › Taxonomia do `failureCode`](ARCHITECTURE.md#taxonomia-do-failurecode) |
| §8 Estratégia de concorrência | [`ARCHITECTURE.md` › Concorrência](ARCHITECTURE.md#concorrência) |
| §9 Algoritmo do `payloadHash` | [`ARCHITECTURE.md` › O hash](ARCHITECTURE.md#o-hash) |
| §9 Mapeamento de status HTTP | [`docs/http-contract.md`](docs/http-contract.md#mapeamento-erro--status) |
| §14 Teste de carga | [`docs/load-test.md`](docs/load-test.md) |

## Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md): decisões, trade-offs e limitações.
- [`docs/http-contract.md`](docs/http-contract.md): envelope, catálogo i18n, tabela erro → status, health e Swagger.
- [`docs/load-test.md`](docs/load-test.md): relatório da carga.
- [`docs/CHALLENGE.md`](docs/CHALLENGE.md): o enunciado.
