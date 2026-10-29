# Handoff: estado do projeto

Retrato do projeto na branch `feat/T09b-sqs-wagering`, que é a branch de integração do MVP. Serve para quem continuar o trabalho saber o que já existe, o que foi validado e o que falta.

## Resumo

- O MVP do serviço está montado e com testes verdes: domínio, persistência, HTTP, SQS, outbox, worker de pendências, observabilidade, auth, multi-instância e caos.
- **Parte do código já passou por QA e está na `dev`.** O restante foi validado só pelos testes automatizados, porque a rodada final de QA não chegou a acontecer.
- Para fechar, faltam três coisas: rodar e documentar a carga (T13), fazer o QA final da branch inteira e fazer o merge na `dev`.

## Branches

| Branch | O que é |
| --- | --- |
| `main` | Só o Carllos mexe. |
| `dev` | Integração aprovada pelo QA. Contém T01, T01b, T02, T02b, T03, T04, T05, T06, T07a e T07m. |
| `feat/T09b-sqs-wagering` | **Branch do MVP.** Contém tudo o que está na `dev` mais T07b, T08, T09a, T09b, T10a, T10b, T11a, T11b, T12, T13 (parcial), T14, a documentação e este handoff. |

As outras branches `feat/T*` já foram mergeadas na branch do MVP e servem só como histórico.

## Estado das suítes na branch do MVP

| Suíte | Resultado |
| --- | --- |
| `lint`, `typecheck` | verdes |
| `test:arch` | 114 pass, nenhuma violação |
| `bun run test` | 1112 pass |
| `test:integration` | 247 pass, 1 fail (esperado, explicado abaixo) |
| `test:concurrency` | verde nas últimas execuções, com `RERUN_EACH` até 20 |
| `test:multi` | verde (carga mista em 3 instâncias e reinício com `kill -9`) |
| `test:chaos` | verde, mas pausa o Postgres compartilhado e precisa rodar isolado |
| `test:auth` | verde contra um Keycloak descartável |
| `test:load` | **não concluído** |

**A falha esperada** está em `tests/integration/infra/sqs-redrive.spec.ts`, no teste "compose init created the shared FIFO queues…". A fila de comandos foi renomeada para `wager-transactions.fifo`, mas o LocalStack que está de pé foi criado com o nome antigo. Recriar o LocalStack a partir de um checkout dessa branch resolve: `docker compose up -d --wait --force-recreate localstack`. As réplicas do `docker-compose.app.yml` dependem da fila nova, então só funcionam depois disso.

## O que foi feito

| Task | Entrega | QA |
| --- | --- | --- |
| T01 / T01b | Scaffold Bun + TS strict + Nest, lint que proíbe dinheiro em `number`, dependency-cruiser, compose com PG e LocalStack, helpers de teste isolados por execução | aprovado |
| T02 / T02b | `Money` em `bigint`, sem negativo, com parse estrito, imutável, e `amount` exposto para a igualdade estrutural nos testes | aprovado |
| T03 | `Wallet`, `WalletLedgerEntry`, cursor e reconciliação pura | aprovado |
| T04 | Inbox, Outbox, `IntegrationEvent`, `PublishOutboxBatch` com fencing por `lease_token` e backoff | aprovado |
| T05 | `WagerTransaction`, transições, policies, `ReferenceResolver`, `WagerSettlement` e `IdempotencyCheck` | aprovado |
| T06 | Use cases, eventos, `ProcessWagerTransaction`, `RetryPendingReferences` e os use cases de wallet | aprovado |
| T07a | Schema com constraints, índices parciais, triggers de imutabilidade e FKs compostas | aprovado |
| T07m | UoW (READ COMMITTED + `lock_timeout`), repositórios de inbox e outbox, guard do pool | aprovado |
| T07b | Repositórios de wallet, ledger e wager, mapeamento de erros e races no PG | correções feitas, **sem revalidação** |
| T08 | API HTTP com envelope, catálogo i18n, filter, validação, Swagger em `/docs`, `/health/ready` e limites de body | correções feitas, **sem revalidação** |
| T09a | Consumer SQS: grupos FIFO, retry dentro do processo, DLQ explícita, breaker e SIGTERM | correções feitas, **sem revalidação** |
| T10a | Publisher da outbox com claim head-of-line por `seq` | correções feitas, **sem revalidação** |
| T10b | Worker de pendências, `Sha256PayloadHasher` e `UuidV7IdGenerator` | aprovado; os follow-ups estão **sem revalidação** |
| T09b | Consumer ligado ao use case real, com crash entre commit e ack | sem QA |
| Montagem | `APP_ROLES`, persistência real no Nest, Dockerfile, `docker-compose.app.yml` (3 réplicas + nginx na 8080), shutdown gracioso e timeouts de HTTP e do handler | sem QA |
| T11a / T11b | Logs pino com `correlationId`, métricas Prometheus, decorators, `/metrics`, Prometheus e Grafana provisionados | sem QA |
| T12 | `test:multi` (3 processos, carga mista e reinício) e `test:chaos` (`docker pause` no PG) | sem QA |
| T14 | Keycloak no profile `auth` e adapter `JwksProviderIdentity` (`AUTH_MODE=noop|jwks`) | sem QA |
| Docs | `README.md`, `ARCHITECTURE.md`, `docs/http-contract.md`, `docs/architecture-notes.md`, `docs/test-infra.md` e o enunciado em `docs/CHALLENGE.md` | sem QA |

## O que falta

1. **T13, carga.** Os cenários k6, o produtor do caminho SQS, o runner e os helpers estão em `tests/load/`, mas a execução foi interrompida.
   - Rodar `bun run test:load`. Ele sobe o compose do app num projeto próprio e não derruba o stack principal.
   - Escrever `docs/load-test.md` em PT-BR, com ambiente, metodologia, throughput, p50/p95/p99, erros por status, conflitos de lock, outbox lag e uma análise honesta. O README já aponta para esse arquivo.
   - Conferir se o produtor SQS da carga usa o nome novo da fila.
2. **Recriar o LocalStack** a partir da branch do MVP (comando na seção de suítes).
3. **QA final** de tudo o que está marcado "sem revalidação" ou "sem QA" na tabela acima. Pontos para atacar com prioridade:
   - **T10a:** a ordem no fio por aggregate com 3 instâncias e o `EXPLAIN` do claim com backlog grande.
   - **T09a:** nenhuma mensagem vai para a DLQ sem ter falhado ela mesma, nem com stop ou deploy no meio. Os repros estão descritos no histórico de commits da T09a.
   - **T07b:** `playerId` fora do formato UUID, byte NUL em texto, escrita em snapshot e o `BALANCE_LIMIT_EXCEEDED` nos dois fluxos.
   - **Montagem:** subir o `docker-compose.app.yml`, conferir o balanceamento pelo `X-Instance-Id`, `docker stop` gracioso e o Grafana com dados reais.
4. **Merge na `dev`** depois do QA, com `--no-ff`, e push.

## Pendências e decisões conhecidas

- **Identidade no canal SQS:** o `providerId` da mensagem vira o próprio `actor`, então o `PROVIDER_IDENTITY_MISMATCH` nunca dispara por esse canal. O §2 do enunciado pede que a identidade da mensagem passe pelas mesmas validações de domínio, e hoje ela passa pelas regras de referência e pelo namespace de idempotência. Vale decidir se basta, e o ARCHITECTURE.md registra o ponto.
- **Lacunas de schema** que só o app valida hoje:
  - uma reversão PROCESSED apontando para OPENING, para uma REJECTED ou para outra reversão;
  - `reference_external_transaction_id` divergindo do external id da transação referenciada.
- **`.env.example`:** as variáveis `PENDING_BACKOFF_*` e `PENDING_MAX_ATTEMPTS` aparecem duplicadas.
- **OTel** (etapa opcional 15) ficou de fora.
- **Postgres compartilhado:** o `test:chaos` pausa o PG por cerca de 20 segundos, então não rode junto com outras suítes.
- **`docker build`:** neste host, o `bun install` dentro do build não resolve DNS na bridge padrão. Por isso o compose usa `build.network: host`.
- **Histórico da `dev`:** o commit `ac38e05`, em `docs/http-contract.md`, tem uma frase que cita outro projeto como origem do padrão. Ela foi removida no commit seguinte, mas continua no histórico publicado.

## Regras do projeto para quem continuar

- `main` é só do Carllos. O trabalho vai para a `dev`, sempre por merge `--no-ff`, e o push é só da `dev`. Nada de force push.
- Autor dos commits: `cadu.oliveira2444@gmail.com`, já configurado no repo. Mensagens em inglês, no formato Conventional Commits.
- **Nenhuma assinatura ou menção a ferramenta de IA** em commits, PRs ou docs.
- Nunca escrever que algo "segue o padrão" de outro projeto. Cada decisão se justifica pelo próprio mérito.
- Dinheiro nunca em `number`. `business/` não importa nada externo, e o Nest fica só em `infrastructure/framework/nest`.
- Testes de integração rodam contra PG e SQS reais. Cada execução cria banco e filas com sufixo único, e o stack do compose é compartilhado.
- Bun fica em `~/.bun/bin/bun`.
- `README.md` e `ARCHITECTURE.md` são em PT-BR.
