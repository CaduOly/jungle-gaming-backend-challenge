# Teste de Carga

Este documento registra a metodologia e os resultados reais da suíte de carga (`bun run test:load`, executada por [`tests/load/run.ts`](../tests/load/run.ts)) contra o stack multi-instância completo (3 réplicas da aplicação atrás do nginx, PostgreSQL 17 e LocalStack SQS FIFO).

## Ambiente e Limites

Os dados abaixo foram colhidos automaticamente pelo runner na execução `2026-10-29T23:35:11.711Z`:

| Item | Valor |
| --- | --- |
| CPU do host | AMD Ryzen 5 5500 (12 threads) |
| RAM do host | 15 GiB |
| Kernel | Linux 7.0.0-28-generic |
| Docker / Compose | 29.1.3 / 2.40.3+ds1-0ubuntu1~24.04.1 |
| Runtime | Bun 1.4.4 (`oven/bun:1.4.4-alpine` nos containers) |
| Banco de dados | PostgreSQL 17.6 |
| Broker SQS | `localstack/localstack:4.4.0` |
| Balanceador HTTP | `nginx:1.27-alpine` (round-robin sobre `app-1`, `app-2`, `app-3`) |
| Gerador HTTP | `grafana/k6:1.3.0` |
| Limite das réplicas (`app-1..3`) | 3 × 1 CPU / 512 MiB (`cpus: "1.0"`, `mem_limit: 512m`) |
| Limite do nginx | 1 CPU (`cpus: "1.0"`) |
| Limite do k6 | 2 CPUs (`--cpus=2`) |
| PostgreSQL e LocalStack | Sem limite artificial de CPU/RAM (stack compartilhado no host) |

## Metodologia

Eu desenhei a suíte em **modelo aberto** (`constant-arrival-rate` no k6 para os cenários HTTP e envio cadenciado em lotes a cada 100 ms no produtor SQS). Num modelo fechado (VUs fixos em loop sem `arrival-rate`), se o servidor fica lento o gerador diminui o ritmo de envio sozinho e esconde a fila; no modelo aberto a taxa ofertada é mantida independentemente da latência do servidor, e qualquer gargalo aparece na hora no `p99`, em `dropped_iterations` ou em respostas `503`.

Cada um dos 4 cenários roda na mesma sequência:

1. **Preparação**: criação das wallets do cenário com saldo inicial alto (`1000000.00` BRL) para medir contenção de lock, banco e fila sem esbarrar em rejeição por saldo insuficiente logo nos primeiros segundos, além do snapshot inicial das métricas Prometheus (`/metrics`) das 3 réplicas e do timestamp SQL para recortar a janela da outbox.
2. **Aquecimento (warm-up)**: **15 s a 20 req/s** (ou 20 cmd/s no SQS). Essa fase aquece o JIT do Bun, o pool de conexões do PostgreSQL e os sockets keep-alive do nginx, e **não entra** nos percentis de latência nem na contagem de requisições do cenário (o k6 filtra as métricas pela tag `scenario:main`, descartando o estágio `warmup`, e o produtor SQS separa a fase `main` no `runSqsPath`).
3. **Medição**: **60 s** na taxa nominal de cada cenário, com amostragem contínua de `docker stats` a cada 2 s nos 6 containers (`app-1`, `app-2`, `app-3`, `nginx`, `postgres`, `localstack`).
4. **Drenagem e coleta**: ao final de cada cenário o runner aguarda a outbox esvaziar (`published_at IS NULL = 0`), recolhe o delta das métricas Prometheus (`lock_wait_seconds`, `lock_conflicts_total` com `type="lock_timeout"` e `type="deadlock"`, `idempotent_duplicates_total`, `outbox_lag_seconds`) somado entre as 3 réplicas e calcula no SQL o lag exato `published_at - occurred_at` em `outbox_messages` de cada evento gerado na janela.
5. **Reconciliação final**: encerrados os 4 cenários, o runner reconcilia **todas as 1.301 wallets** utilizadas tanto pelo endpoint `POST /wallets/:id/reconciliation` quanto por consulta SQL direta no ledger (`findWalletInconsistencies`).

| Parâmetro | Valor |
| --- | --- |
| `warmupSeconds` / `warmupRate` | 15 s a 20/s |
| `durationSeconds` | 60 s por cenário |
| `rateDistributed` / `walletsDistributed` | 300 req/s sobre 1.000 wallets |
| `rateHot` | 100 req/s sobre 1 única wallet |
| `rateMix` / `walletsMix` | 300 req/s sobre 200 wallets (85% inéditas, 10% replays, 5% conflitos) |
| `rateSqs` / `walletsSqs` | 100 cmd/s sobre 100 wallets (1 `MessageGroupId` por wallet) |
| `maxVus` (k6) | 400 |

---

## Resultados por Cenário

### 1. Distribuído (1.000 wallets)

Apostas e liquidações (`BET` e `WIN`) distribuídas uniformemente entre 1.000 wallets a 300 req/s.

| Taxa ofertada (req/s) | Requisições | Throughput (req/s) | Iterações descartadas | p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 300 | 18.001 | 300 | 0 | 9,2 | 18,5 | 48,3 | 164,0 |

| Operação e status | Requisições |
| --- | --- |
| `fresh 200` | 18.000 |
| `fresh 502` | 1 |

- **Respostas fora do esperado**: 1 (`502` pontual do nginx na troca de conexão upstream em 18.001 requisições, equivalente a 0,0055%).
- **Replays com resposta divergente**: 0.

| `lock_wait` (amostras) | `lock_wait` p50 (ms) | p95 (ms) | p99 (ms) | Lock timeouts | Deadlocks | Replays (métrica) |
| --- | --- | --- | --- | --- | --- | --- |
| 18.301 | 2,5 | 4,8 | 5,0 | 0 | 0 | 0 |

| Outbox (eventos) | Lag SQL p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) | Não publicados ao fim | Lag métrica p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 33.511 | 18.198 | 24.089 | 24.158 | 24.272 | 0 | 28.603,1 |

| Container | CPU média (%) | CPU pico (%) | RAM média (MiB) |
| --- | --- | --- | --- |
| `app-1` | 44,5 | 71,4 | 131 |
| `app-2` | 44,9 | 72,3 | 131 |
| `app-3` | 44,5 | 69,8 | 131 |
| `nginx` | 5,3 | 7,5 | 13 |
| `postgres` | 142,1 | 203,8 | 161 |
| `localstack` | 78,2 | 142,1 | 157 |

---

### 2. Hot Wallet (1 wallet)

Todas as 100 req/s batendo na **mesma wallet**, forçando serialização total no `SELECT ... FOR UPDATE` da linha da carteira entre as 3 réplicas.

| Taxa ofertada (req/s) | Requisições | Throughput (req/s) | Iterações descartadas | p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 6.001 | 100 | 0 | 6,7 | 8,6 | 15,5 | 245,1 |

| Operação e status | Requisições |
| --- | --- |
| `fresh 200` | 6.001 |

- **Respostas fora do esperado**: 0.
- **Replays com resposta divergente**: 0.

| `lock_wait` (amostras) | `lock_wait` p50 (ms) | p95 (ms) | p99 (ms) | Lock timeouts | Deadlocks | Replays (métrica) |
| --- | --- | --- | --- | --- | --- | --- |
| 6.302 | 2,5 | 4,8 | 5,0 | 0 | 0 | 0 |

| Outbox (eventos) | Lag SQL p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) | Não publicados ao fim | Lag métrica p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 11.117 | 12.784 | 22.026,6 | 22.671,8 | 22.859 | 0 | 28.291,5 |

| Container | CPU média (%) | CPU pico (%) | RAM média (MiB) |
| --- | --- | --- | --- |
| `app-1` | 15,2 | 23,4 | 128 |
| `app-2` | 15,0 | 34,6 | 123 |
| `app-3` | 15,5 | 25,1 | 125 |
| `nginx` | 1,7 | 2,2 | 12 |
| `postgres` | 51,5 | 63,6 | 178 |
| `localstack` | 37,0 | 59,0 | 225 |

---

### 3. Mix com Replays e Conflitos (200 wallets)

Carga mista a 300 req/s sobre 200 wallets, combinando submissões inéditas (~88,5%), replays idempotentes com mesmo `Idempotency-Key` e mesmo payload (~9,7%) e conflitos de idempotência com mesma `Idempotency-Key` e payload adulterado (~1,8%).

| Taxa ofertada (req/s) | Requisições | Throughput (req/s) | Iterações descartadas | p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 300 | 18.000 | 300 | 0 | 8,2 | 12,5 | 21,8 | 113,1 |

| Operação e status | Requisições |
| --- | --- |
| `fresh 200` | 15.921 |
| `replay 200` | 1.746 |
| `conflict 409` | 332 |
| `fresh 502` | 1 |

- **Respostas fora do esperado**: 1 (`502` pontual em 18.000 requisições).
- **Replays com resposta divergente**: 0 (todos os 1.746 replays devolveram exatamente o `transactionId`, `status` e `balance` observados na decisão original, com `idempotentReplay: true`).

| Operação | Requisições | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | --- | --- | --- | --- |
| `fresh` | 15.922 | 8,4 | 12,9 | 23,0 |
| `replay` | 1.746 | 2,9 | 5,3 | 8,7 |
| `conflict` | 332 | 2,9 | 5,2 | 9,5 |

| `lock_wait` (amostras) | `lock_wait` p50 (ms) | p95 (ms) | p99 (ms) | Lock timeouts | Deadlocks | Replays (métrica) |
| --- | --- | --- | --- | --- | --- | --- |
| 16.197 | 2,5 | 4,8 | 5,0 | 0 | 0 | 1.766 |

| Outbox (eventos) | Lag SQL p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) | Não publicados ao fim | Lag métrica p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 29.421 | 4.526 | 6.841 | 6.994 | 7.092 | 0 | 9.392,1 |

| Container | CPU média (%) | CPU pico (%) | RAM média (MiB) |
| --- | --- | --- | --- |
| `app-1` | 43,5 | 78,5 | 136 |
| `app-2` | 39,2 | 60,7 | 135 |
| `app-3` | 40,1 | 71,7 | 136 |
| `nginx` | 4,9 | 6,7 | 13 |
| `postgres` | 122,1 | 199,7 | 223 |
| `localstack` | 93,4 | 159,4 | 272 |

---

### 4. Caminho SQS (100 wallets, um `MessageGroupId` por wallet)

Envio direto para a fila FIFO `wager-transactions-<suffix>.fifo` a 100 cmd/s (lotes `SendMessageBatch` de 10 mensagens a cada 100 ms), consumido pelas 3 réplicas da aplicação. A latência ponta a ponta é medida entre o timestamp de envio do produtor (`sentAt` gravado antes do `SendMessageBatch`) e o `coalesce(processed_at, created_at)` gravado na transação pelo consumidor ao commitar no PostgreSQL.

| Taxa ofertada (cmd/s) | Enviados | Aplicados | Faltando | Throughput (cmd/s) | p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 6.000 | 6.000 | 0 | 100,2 | 7,0 | 11,0 | 54,0 | 283,0 |

- **Status finais**: `PROCESSED` 6.000 (100%).
- **Falhas de envio**: 0.

| `lock_wait` (amostras) | `lock_wait` p50 (ms) | p95 (ms) | p99 (ms) | Lock timeouts | Deadlocks | Replays (métrica) |
| --- | --- | --- | --- | --- | --- | --- |
| 6.300 | 2,5 | 4,8 | 5,0 | 0 | 0 | 0 |

| Outbox (eventos) | Lag SQL p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) | Não publicados ao fim | Lag métrica p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 10.794 | 101,5 | 242,0 | 313,1 | 533,0 | 0 | 259,2 |

| Container | CPU média (%) | CPU pico (%) | RAM média (MiB) |
| --- | --- | --- | --- |
| `app-1` | 10,9 | 20,3 | 137 |
| `app-2` | 10,7 | 18,6 | 131 |
| `app-3` | 11,6 | 19,6 | 136 |
| `nginx` | 0,0 | 0,0 | 10 |
| `postgres` | 43,1 | 94,5 | 277 |
| `localstack` | 48,3 | 77,2 | 342 |

---

## Reconciliação Final

Ao término dos 4 cenários (~48.000 transações na fase de medição mais o warm-up, totalizando mais de 84.000 eventos publicados na outbox):

- **Via API (`POST /wallets/:id/reconciliation`)**: **1.301 de 1.301 wallets** retornaram `consistent: true`, ou seja, o `storedBalance` da wallet bate com o `calculatedBalance` reconstruído pelo ledger, e as versões dos lançamentos são consecutivas até a `version` da wallet.
- **Via SQL direto no ledger (`findWalletInconsistencies`)**: **0 violações** — nenhuma wallet ou lançamento com saldo negativo, nenhuma lacuna ou duplicidade na sequência `wallet_version`, nenhum `balance_before` desalinhado com o `balance_after` anterior, e o saldo da wallet igual à soma de créditos menos débitos do ledger.

---

## Análise dos Resultados

### 1. Distribuído vs. Hot Wallet (`SELECT ... FOR UPDATE`)

À primeira vista parece contraintuitivo que o cenário **Hot Wallet** (100 req/s numa única carteira) tenha apresentado `p50` de **6,7 ms** e `p95` de **8,6 ms**, menores que os **9,2 ms** (`p50`) e **18,5 ms** (`p95`) do cenário **Distribuído** (300 req/s em 1.000 carteiras). A explicação vem de dois fatores:

1. **Taxa global de commits e I/O no PostgreSQL**: a 100 req/s o banco faz 3× menos `fsync` de WAL e as réplicas rodam a ~15% de CPU (contra ~45% de CPU por réplica e 142% no Postgres a 300 req/s). Como a seção crítica dentro da transação SQL é curta (~2,5 ms de `SELECT ... FOR UPDATE` + `INSERT` em `wager_transactions`, `wallet_ledger_entries` e `outbox_messages` + `UPDATE` em `wallets`), a 100 req/s o intervalo médio de chegada é de 10 ms — maior que o tempo de serviço da transação. Por isso quase não se forma fila no lock da linha (`lock_wait p95 = 4,8 ms`, `0 lock timeouts`).
2. **Cauda máxima (`máx = 245,1 ms` na Hot Wallet vs. `164,0 ms` no Distribuído)**: quando rajadas pontuais enfileiram várias requisições simultâneas na mesma linha, a última da fila espera a soma das transações anteriores, o que aparece no pico máximo de 245,1 ms sem chegar perto do `DB_LOCK_TIMEOUT_MS` (2.000 ms).

### 2. O efeito do pre-check sem lock nos replays e conflitos (Cenário Mix)

No cenário **Mix**, as submissões inéditas (`fresh`) tiveram `p50 = 8,4 ms` e `p95 = 12,9 ms`, enquanto os **replays** (`p50 = 2,9 ms`, `p95 = 5,3 ms`) e os **conflitos 409** (`p50 = 2,9 ms`, `p95 = 5,2 ms`) responderam em menos da metade do tempo.

Isso comprova na prática a decisão descrita em `ARCHITECTURE.md`: antes de abrir a transação de escrita e disputar o `SELECT ... FOR UPDATE` da wallet, o use case faz uma leitura simples por `(provider_id, idempotency_key)`. Quando a transação original já está commitada num estado terminal (`PROCESSED` ou `REJECTED`), o replay ou o conflito `409 IDEMPOTENCY_CONFLICT` é resolvido imediatamente em ~3 ms sem tocar no lock da carteira e sem gerar escrita no banco. Isso também aparece no número de amostras de `lock_wait`: para 18.000 requisições no período de medição (+ 300 do warm-up), houve apenas **16.197** aquisições de lock (exatamente as submissões inéditas), poupando a carteira dos 1.746 replays e 332 conflitos.

### 3. O gargalo real: vazão de publicação da Outbox no LocalStack

O dado mais revelador do teste está na tabela de **outbox**:

- A **100 cmd/s** (cenário SQS, gerando ~180 eventos/s na outbox, já que cada `BET` gera `WagerTransactionProcessed` e `WalletBalanceChanged`), o lag de publicação da outbox ficou em **`p50 = 101,5 ms` e `p95 = 242 ms`** — praticamente o intervalo de polling do worker (`OUTBOX_POLL_INTERVAL_MS = 200 ms`).
- Já a **300 req/s** (cenários Distribuído e Mix, gerando ~500 a 560 eventos/s na outbox), o lag SQL subiu para **`18,2 s` (`p50`) / `24,1 s` (`p95`)** no Distribuído e **`4,5 s` (`p50`) / `6,8 s` (`p95`)** no Mix, embora **todos os eventos tenham sido entregues ao final (`não publicados ao fim = 0`)**.

O motivo é mecânico: o `OutboxPublisherWorker` publica os eventos da fila `wagering-events.fifo` sequencialmente por lote (`OUTBOX_BATCH_SIZE = 10`, um `SendMessageCommand` por evento no LocalStack). Com 3 réplicas publicando em paralelo contra o LocalStack em container único (que bateu 142%–159% de CPU), a vazão máxima de chamadas `SendMessage` individuais fica em torno de ~380–420 eventos/s. Quando a entrada gera 550 eventos/s, a tabela `outbox_messages` acumula uma fila que é drenada assim que a rajada termina, **sem impactar a latência HTTP do cliente (`p95 = 18,5 ms`)**. Esse resultado valida o desacoplamento via Transactional Outbox: a escrita síncrona não sofre com a latência do broker, e para escalar a vazão da outbox acima de 500 eventos/s bastaria trocar o envio unitário por `SendMessageBatch` (até 10 mensagens por round-trip HTTP ao SQS) ou aumentar `OUTBOX_BATCH_SIZE`.

### 4. Latência ponta a ponta no Caminho SQS

Com 100 wallets (100 `MessageGroupId` distintos na fila FIFO), as 3 réplicas consumiram em paralelo com long polling (`WaitTimeSeconds = 20`, `MaxNumberOfMessages = 10`) e mantiveram a fila limpa durante todo o minuto de medição: **6.000 de 6.000 mensagens processadas**, throughput de **100,2 cmd/s**, `p50` de **7 ms** e `p95` de **11 ms** entre o envio e o commit no banco, com apenas ~11% de CPU em cada réplica.
