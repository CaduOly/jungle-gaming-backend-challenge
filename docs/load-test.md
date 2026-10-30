# Teste de Carga

Este documento registra a metodologia e os resultados reais da suíte de carga (`bun run test:load`, executada por [`tests/load/run.ts`](../tests/load/run.ts)) contra o stack multi-instância completo (3 réplicas da aplicação atrás do nginx, PostgreSQL 17 e LocalStack SQS FIFO).

## Ambiente e Limites

Os dados abaixo foram colhidos automaticamente pelo runner na execução `2026-10-30T03:42:10.169Z`:

| Item | Valor |
| --- | --- |
| CPU do host | Intel Core Ultra 7 155U (14 threads) |
| RAM do host | 15 GiB |
| Kernel | Linux 7.0.0-38-generic |
| Docker / Compose | 29.9.2 / 5.6.1 |
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
| 300 | 18.000 | 300 | 0 | 8,2 | 12,9 | 25,1 | 112,2 |

| Operação e status | Requisições |
| --- | --- |
| `fresh 200` | 17.999 |
| `fresh 502` | 1 |

- **Respostas fora do esperado**: 1 (`502` pontual do nginx na troca de conexão upstream em 18.000 requisições, equivalente a 0,0056%).
- **Replays com resposta divergente**: 0.

| `lock_wait` (amostras) | `lock_wait` p50 (ms) | p95 (ms) | p99 (ms) | Lock timeouts | Deadlocks | Replays (métrica) |
| --- | --- | --- | --- | --- | --- | --- |
| 18.300 | 2,5 | 4,8 | 5,0 | 0 | 0 | 0 |

| Outbox (eventos) | Lag SQL p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) | Não publicados ao fim | Lag métrica p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 33.281 | 12.755 | 19.524 | 19.568 | 19.668 | 0 | 28.264,3 |

| Container | CPU média (%) | CPU pico (%) | RAM média (MiB) |
| --- | --- | --- | --- |
| `app-1` | 45,5 | 70,0 | 131 |
| `app-2` | 46,0 | 71,4 | 131 |
| `app-3` | 47,0 | 70,2 | 131 |
| `nginx` | 4,6 | 6,2 | 15 |
| `postgres` | 151,0 | 207,3 | 174 |
| `localstack` | 85,7 | 153,0 | 159 |

---

### 2. Hot Wallet (1 wallet)

Todas as 100 req/s batendo na **mesma wallet**, forçando serialização total no `SELECT ... FOR UPDATE` da linha da carteira entre as 3 réplicas.

| Taxa ofertada (req/s) | Requisições | Throughput (req/s) | Iterações descartadas | p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 6.001 | 100 | 0 | 6,4 | 8,4 | 10,4 | 34,3 |

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
| 11.117 | 4.522 | 7.010 | 7.095,8 | 7.119 | 0 | 9.380,2 |

| Container | CPU média (%) | CPU pico (%) | RAM média (MiB) |
| --- | --- | --- | --- |
| `app-1` | 15,1 | 24,7 | 122 |
| `app-2` | 15,5 | 24,8 | 125 |
| `app-3` | 15,0 | 25,4 | 123 |
| `nginx` | 1,6 | 2,1 | 14 |
| `postgres` | 53,9 | 69,3 | 180 |
| `localstack` | 36,9 | 78,3 | 223 |

---

### 3. Mix com Replays e Conflitos (200 wallets)

Carga mista a 300 req/s sobre 200 wallets, combinando submissões inéditas (~88,1%), replays idempotentes com mesmo `Idempotency-Key` e mesmo payload (~9,9%) e conflitos de idempotência com mesma `Idempotency-Key` e payload adulterado (~2,0%).

| Taxa ofertada (req/s) | Requisições | Throughput (req/s) | Iterações descartadas | p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 300 | 18.001 | 300 | 0 | 7,7 | 12,2 | 25,6 | 86,5 |

| Operação e status | Requisições |
| --- | --- |
| `fresh 200` | 15.853 |
| `replay 200` | 1.781 |
| `conflict 409` | 367 |

- **Respostas fora do esperado**: 0.
- **Replays com resposta divergente**: 0 (todos os 1.781 replays devolveram exatamente o `transactionId`, `status` e `balance` observados na decisão original, com `idempotentReplay: true`).

| Operação | Requisições | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | --- | --- | --- | --- |
| `fresh` | 15.853 | 7,9 | 12,5 | 28,3 |
| `replay` | 1.781 | 3,2 | 5,1 | 8,5 |
| `conflict` | 367 | 3,1 | 4,9 | 8,8 |

| `lock_wait` (amostras) | `lock_wait` p50 (ms) | p95 (ms) | p99 (ms) | Lock timeouts | Deadlocks | Replays (métrica) |
| --- | --- | --- | --- | --- | --- | --- |
| 16.121 | 2,5 | 4,8 | 5,0 | 0 | 0 | 1.809 |

| Outbox (eventos) | Lag SQL p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) | Não publicados ao fim | Lag métrica p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 29.362 | 3.877 | 8.178 | 8.381 | 8.547 | 0 | 9.369,8 |

| Container | CPU média (%) | CPU pico (%) | RAM média (MiB) |
| --- | --- | --- | --- |
| `app-1` | 43,9 | 69,6 | 135 |
| `app-2` | 41,7 | 59,6 | 138 |
| `app-3` | 41,0 | 56,4 | 135 |
| `nginx` | 4,7 | 6,5 | 15 |
| `postgres` | 122,0 | 221,8 | 246 |
| `localstack` | 96,8 | 154,1 | 267 |

---

### 4. Caminho SQS (100 wallets, um `MessageGroupId` por wallet)

Envio direto para a fila FIFO `wager-transactions-<suffix>.fifo` a 100 cmd/s (lotes `SendMessageBatch` de 10 mensagens a cada 100 ms), consumido pelas 3 réplicas da aplicação. A latência ponta a ponta é medida entre o timestamp de envio do produtor (`sentAt` gravado antes do `SendMessageBatch`) e o `coalesce(processed_at, created_at)` gravado na transação pelo consumidor ao commitar no PostgreSQL.

| Taxa ofertada (cmd/s) | Enviados | Aplicados | Faltando | Throughput (cmd/s) | p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 6.000 | 6.000 | 0 | 100,2 | 7,0 | 12,0 | 20,0 | 222,0 |

- **Status finais**: `PROCESSED` 6.000 (100%).
- **Falhas de envio**: 0.

| `lock_wait` (amostras) | `lock_wait` p50 (ms) | p95 (ms) | p99 (ms) | Lock timeouts | Deadlocks | Replays (métrica) |
| --- | --- | --- | --- | --- | --- | --- |
| 6.300 | 2,5 | 4,8 | 5,0 | 0 | 0 | 0 |

| Outbox (eventos) | Lag SQL p50 (ms) | p95 (ms) | p99 (ms) | Máx (ms) | Não publicados ao fim | Lag métrica p95 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| 10.826 | 96,0 | 235,0 | 269,0 | 455,0 | 0 | 242,0 |

| Container | CPU média (%) | CPU pico (%) | RAM média (MiB) |
| --- | --- | --- | --- |
| `app-1` | 12,4 | 19,1 | 135 |
| `app-2` | 11,7 | 23,2 | 136 |
| `app-3` | 9,9 | 14,9 | 136 |
| `nginx` | 0,0 | 0,1 | 12 |
| `postgres` | 36,1 | 55,4 | 289 |
| `localstack` | 54,4 | 100,8 | 333 |

---

## Reconciliação Final

Ao término dos 4 cenários (~48.000 transações na fase de medição mais o warm-up, totalizando mais de 84.000 eventos publicados na outbox):

- **Via API (`POST /wallets/:id/reconciliation`)**: **1.301 de 1.301 wallets** retornaram `consistent: true`, ou seja, o `storedBalance` da wallet bate com o `calculatedBalance` reconstruído pelo ledger, e as versões dos lançamentos são consecutivas até a `version` da wallet.
- **Via SQL direto no ledger (`findWalletInconsistencies`)**: **0 violações** — nenhuma wallet ou lançamento com saldo negativo, nenhuma lacuna ou duplicidade na sequência `wallet_version`, nenhum `balance_before` desalinhado com o `balance_after` anterior, e o saldo da wallet igual à soma de créditos menos débitos do ledger.

---

## Análise dos Resultados

### 1. Distribuído vs. Hot Wallet (`SELECT ... FOR UPDATE`)

À primeira vista parece contraintuitivo que o cenário **Hot Wallet** (100 req/s numa única carteira) tenha apresentado `p50` de **6,4 ms** e `p95` de **8,4 ms**, menores que os **8,2 ms** (`p50`) e **12,9 ms** (`p95`) do cenário **Distribuído** (300 req/s em 1.000 carteiras). A explicação vem de dois fatores:

1. **Taxa global de commits e I/O no PostgreSQL**: a 100 req/s o banco faz 3× menos `fsync` de WAL e as réplicas rodam a ~15% de CPU (contra ~46% de CPU por réplica e 151% no Postgres a 300 req/s). Como a seção crítica dentro da transação SQL é curta (~2,5 ms de `SELECT ... FOR UPDATE` + `INSERT` em `wager_transactions`, `wallet_ledger_entries` e `outbox_messages` + `UPDATE` em `wallets`), a 100 req/s o intervalo médio de chegada é de 10 ms — maior que o tempo de serviço da transação. Por isso quase não se forma fila no lock da linha (`lock_wait p95 = 4,8 ms`, `0 lock timeouts`).
2. **Cauda (`p99 = 10,4 ms` e `máx = 34,3 ms` na Hot Wallet vs. `p99 = 25,1 ms` e `máx = 112,2 ms` no Distribuído)**: nesta execução a cauda da Hot Wallet também ficou abaixo da do Distribuído. Mesmo serializando todas as requisições na mesma linha, a pior espera ficou em 34,3 ms, muito longe do `DB_LOCK_TIMEOUT_MS` (2.000 ms); a 100 req/s as eventuais filas no lock são curtas e drenam rápido. No Distribuído, onde não há disputa pela mesma linha, a cauda acompanha a carga global maior (Postgres com pico de 207,3% de CPU), e não a contenção de lock.

### 2. O efeito do pre-check sem lock nos replays e conflitos (Cenário Mix)

No cenário **Mix**, as submissões inéditas (`fresh`) tiveram `p50 = 7,9 ms` e `p95 = 12,5 ms`, enquanto os **replays** (`p50 = 3,2 ms`, `p95 = 5,1 ms`) e os **conflitos 409** (`p50 = 3,1 ms`, `p95 = 4,9 ms`) responderam em menos da metade do tempo.

Isso comprova na prática a decisão descrita em `ARCHITECTURE.md`: antes de abrir a transação de escrita e disputar o `SELECT ... FOR UPDATE` da wallet, o use case faz uma leitura simples por `(provider_id, idempotency_key)`. Quando a transação original já está commitada num estado terminal (`PROCESSED` ou `REJECTED`), o replay ou o conflito `409 IDEMPOTENCY_CONFLICT` é resolvido imediatamente em ~3 ms sem tocar no lock da carteira e sem gerar escrita no banco. Isso também aparece no número de amostras de `lock_wait`: para 18.001 requisições no período de medição (+ 300 do warm-up), houve **16.121** aquisições de lock. Esse número cobre as 15.853 submissões inéditas medidas mais as do aquecimento (o contador Prometheus não separa as fases), e fica bem abaixo do total de requisições: os 1.781 replays e 367 conflitos não passaram pelo lock da carteira.

### 3. O gargalo real: vazão de publicação da Outbox no LocalStack

O dado mais revelador do teste está na tabela de **outbox**:

- A **100 cmd/s** (cenário SQS, em que cada `BET` gera `WagerTransactionProcessed` e `WalletBalanceChanged`), o lag de publicação da outbox ficou em **`p50 = 96 ms` e `p95 = 235 ms`** — praticamente o intervalo de polling do worker (`OUTBOX_POLL_INTERVAL_MS = 200 ms`).
- Já a **300 req/s** (cenários Distribuído e Mix), o lag SQL subiu para **`12,8 s` (`p50`) / `19,5 s` (`p95`)** no Distribuído e **`3,9 s` (`p50`) / `8,2 s` (`p95`)** no Mix, embora **todos os eventos tenham sido entregues ao final (`não publicados ao fim = 0`)**.

O motivo é mecânico: o `OutboxPublisherWorker` publica os eventos da fila `wagering-events.fifo` sequencialmente por lote (`OUTBOX_BATCH_SIZE = 10`, um `SendMessageCommand` por evento no LocalStack). Com 3 réplicas publicando em paralelo contra o LocalStack em container único (que bateu 153%–154% de CPU de pico nos cenários a 300 req/s), a vazão de chamadas `SendMessage` individuais fica abaixo da taxa de geração de eventos, e a tabela `outbox_messages` acumula uma fila que é drenada assim que a rajada termina, **sem impactar a latência HTTP do cliente (`p95 = 12,9 ms` no Distribuído)**. Esse resultado valida o desacoplamento via Transactional Outbox: a escrita síncrona não sofre com a latência do broker, e para escalar a vazão da outbox bastaria trocar o envio unitário por `SendMessageBatch` (até 10 mensagens por round-trip HTTP ao SQS) ou aumentar `OUTBOX_BATCH_SIZE`.

### 4. Latência ponta a ponta no Caminho SQS

Com 100 wallets (100 `MessageGroupId` distintos na fila FIFO), as 3 réplicas consumiram em paralelo com long polling (`WaitTimeSeconds = 20`, `MaxNumberOfMessages = 10`) e mantiveram a fila limpa durante todo o minuto de medição: **6.000 de 6.000 mensagens processadas**, throughput de **100,2 cmd/s**, `p50` de **7 ms** e `p95` de **12 ms** entre o envio e o commit no banco, com ~10–12% de CPU em cada réplica.
