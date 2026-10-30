# Arquitetura

Este documento junta as decisões que não saem óbvias do código, o trade-off de cada uma e o que ficou de fora. O enunciado está em [`docs/CHALLENGE.md`](docs/CHALLENGE.md), e o contrato HTTP detalhado em [`docs/http-contract.md`](docs/http-contract.md).

## Camadas

O código fica em duas pastas, e a separação é verificada por `bun run test:arch` (dependency-cruiser):

`src/business` -> regra pura, entidades, value objects, policies, domain services, ports e use cases. Não importa nada externo nem `infrastructure/`, e não usa `Bun`, `process`, relógio (`Date.now`, `new Date()` sem argumento) nem aleatoriedade (`Math.random`, `crypto.randomUUID`). Do `Math` só ficam liberadas as funções sem efeito em dinheiro, como `min`, `max` e `floor`, que o backoff usa.
`src/infrastructure` -> adapters dos ports: MikroORM, SQS, `jose`, pino, prom-client, config, workers, e o Nest isolado em `src/infrastructure/framework/nest`.

Um contexto (`wallet`, `wagering`, `messaging`) só importa outro por `entity`, `event`, `port` ou `value-object`, nunca por `use-case`. Métrica, log e tracing não entram no business, eles são decorators de use case na infraestrutura que leem o output (`status`, `idempotentReplay`, `consistent`).

### Nest isolado em `framework/nest`

A doc do Nest não prescreve camadas, e o caminho natural dela é colocar `@Injectable()` no use case e, no CQRS, fazer o agregado estender `AggregateRoot`, então o business passaria a depender do framework. Eu preferi deixar o Nest só na borda: controllers, DTOs com class-validator e Swagger, guard, filter, interceptors e os providers com `useFactory` que montam os use cases. O custo é ter um pouco mais de código de composição (`shared/di/*.providers.ts`) e não usar a injeção do Nest dentro do business, e o ganho é que o consumer SQS, o worker de outbox e o worker de pendências chamam os mesmos use cases sem subir o Nest, e os testes de unidade rodam com fakes em memória sem `TestingModule`.

## Dinheiro: `bigint` e nada de arredondamento

`Money` guarda o valor em centavos num `bigint` privado, e no banco tudo é `numeric(20,2)`. Eu não usei uma lib de Decimal porque o domínio só precisa de soma, subtração e comparação em escala fixa de 2 casas, então um `bigint` em centavos é exato, não tem dependência e não abre espaço para alguém configurar uma precisão ou um modo de arredondamento diferente em outro lugar. O lint bloqueia `parseFloat`, `parseInt`, `Number(`, `toFixed`, `toPrecision` e a coerção por `+x`, justamente para o valor nunca passar por `number`. O `tests/arch/money-lint.spec.ts` prova cada bloqueio.

A entrada aceita só string no formato `^(0|[1-9]\d{0,17})\.\d{2}$`, ou seja, exatamente duas casas, sem zero à esquerda, sem sinal, sem expoente e com no máximo 18 dígitos inteiros, que é o que cabe em `numeric(20,2)`. Não existe política de arredondamento, a política é **rejeitar**: `"25.5"`, `"1."`, `".5"`, `"1e2"`, `" 1"` e número JSON voltam 400. Se eu arredondasse, a API aceitaria um valor que o provedor não mandou, e a diferença de um centavo só apareceria na auditoria.

O teto (`999999999999999999.99`) também vale para o resultado. Um crédito que passaria do máximo vira `REJECTED` com `BALANCE_LIMIT_EXCEEDED`, um código que não está no enunciado e que eu acrescentei para isso ser rejeição de negócio e não erro 500. A wallet calcula o saldo novo antes de mudar qualquer coisa, então ela fica exatamente como estava.

## Concorrência

### READ COMMITTED + lock pessimista por wallet

Cada submissão roda numa transação READ COMMITTED que começa com `SELECT … FROM wallets WHERE id = ? FOR UPDATE`. Duas BETs na mesma wallet ficam em fila nesse lock, e a segunda já lê o saldo que a primeira deixou, então o cenário de 2 × 80.00 sobre 100.00 termina com uma `PROCESSED`, uma `REJECTED` e saldo 20.00, sem lost update. Wallets diferentes nunca se bloqueiam, porque o lock é por linha e não existe lock global.

Eu escolhi lock pessimista e não otimista porque a wallet quente (um jogador com muita aposta seguida) é exatamente o caso em que o otimista vira tempestade de retry, e porque com o lock o retry deixa de ser responsabilidade do cliente. O `CHECK (balance >= 0)` no banco fica como última barreira se alguma regra falhar.

A ordem dos locks é sempre **wallet → transação**, inclusive no worker de pendências, que trava a wallet e só depois a transação pendente e reconfere o status. Com uma ordem só não tem ciclo, então não tem deadlock entre o fluxo HTTP/SQS e o worker.

### `lock_timeout`

Toda unidade de trabalho faz `set_config('lock_timeout', '<DB_LOCK_TIMEOUT_MS>ms', true)`, que é o equivalente de `SET LOCAL` e morre junto com a transação, sem vazar para a conexão do pool. O padrão é 2s. Se o lock não vem nesse tempo, o PostgreSQL devolve `55P03`, que vira `TransientInfrastructureError`, e isso sai como **503 + `Retry-After`** na HTTP e como retry no SQS. O mesmo vale para deadlock (`40P01`), falha de serialização, conexão perdida e timeout do pool (`DB_POOL_ACQUIRE_TIMEOUT_MS`). Sem esse teto, uma wallet travada seguraria uma conexão do pool por tempo indeterminado.

### O papel do `version`

Num desenho pessimista o `version` não é o controle de concorrência, quem serializa é o lock. Mesmo assim ele faz três coisas:

`wallets.version` -> o update é `SET balance = ?, version = version + 1 WHERE id = ? AND version = ?`. Se alguém atualizar a wallet sem segurar o lock, o `WHERE` não casa e o repositório falha alto, em vez de sobrescrever em silêncio. Um trigger também impede o `version` de voltar.
`wallet_ledger_entries.wallet_version` -> cada lançamento grava a versão que gerou, com `UNIQUE(wallet_id, wallet_version)`, então o ledger fica encadeado à wallet e a reconciliação (e o `assertWalletConsistency` dos testes) confere que as versões são consecutivas e que a última é a da wallet.
`walletVersion` nos eventos -> é o número que o consumidor downstream usa para ordenar os eventos de uma wallet (ver outbox).

## `WagerTransaction`: transições e replay

| De | Para |
| --- | --- |
| `PENDING` (só em memória, nunca persistido) | `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` |
| `PENDING_REFERENCE` | `PROCESSED`, `REJECTED`, `FAILED` |
| `PROCESSED`, `REJECTED`, `FAILED` | nenhuma, são terminais |

A entidade lança `InvalidTransactionStateError` numa transição fora da tabela, e o trigger de `wager_transactions` bloqueia no banco a saída de status terminal, o `DELETE` e a alteração das colunas imutáveis. `FAILED` só aparece no worker de pendências, quando ele encontra uma inconsistência permanente, como a wallet sumir ou a referência violar uma invariante.

O replay devolve a **decisão original**, não o estado atual. Para isso toda decisão grava `observed_balance`, o saldo visto no momento da decisão, em `PROCESSED` e `REJECTED` (o `CHECK wager_transactions_observed_balance_on_outcome` obriga). Então se a primeira BET deixou 975.00 e a segunda levou para 950.00, o replay da primeira continua respondendo 975.00, com o mesmo status HTTP e `idempotentReplay: true`. Um `REJECTED` replayado volta 422 com o mesmo `failureCode`. A exceção é o `PENDING_REFERENCE`, cujo replay devolve o estado atual, já que ele ainda não tem decisão.

Na HTTP existe uma pré-checagem de idempotência sem lock antes de travar a wallet, que responde o replay de uma decisão já commitada sem entrar na fila do lock. Ela é só otimização para hot wallet, a decisão de verdade é a `IdempotencyCheck` depois do lock.

## Referências: REFUND → ROLLBACK

Quem pode referenciar quem:

| Kind | Referência aceita |
| --- | --- |
| `WIN`, `LOSS`, `REFUND` | `BET` |
| `ROLLBACK` | `BET`, `WIN` ou `REFUND` |

A leitura literal do enunciado deixaria uma BET receber um REFUND e depois um ROLLBACK, e a casa devolveria o dinheiro duas vezes. Por isso cada referência é revertida **uma vez no total**, por REFUND ou por ROLLBACK, e só pelo valor cheio (`AMOUNT_MISMATCH` caso contrário). Isso não fica só na policy: o índice único parcial `wager_transactions_single_reversal_per_reference` em `(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')` garante no banco, então um REFUND e um ROLLBACK da mesma BET em paralelo terminam com exatamente um `PROCESSED` (testado em `test:concurrency`).

O ROLLBACK de um REFUND é permitido, porque a referência é outra linha. A consequência é que a BET volta a ficar debitada e não pode ser reembolsada de novo, já que o slot de reversão dela já foi usado pelo REFUND. Eu prefiro essa consequência, que é explícita e testada, do que abrir um caminho para crédito duplo.

A referência fora de ordem (o ROLLBACK chega antes da BET) vira `PENDING_REFERENCE`, e o worker tenta de novo com backoff exponencial e jitter (base 2s, teto 60s, 8 tentativas, uns 5 minutos). Esgotado, vira `REJECTED / REFERENCE_NOT_FOUND`. Se a referência existe mas está `REJECTED` ou `FAILED`, a dependente é rejeitada na hora com `REFERENCE_NOT_PROCESSED`. A referência também precisa ser do mesmo provedor, jogador, wallet, rodada e moeda, e no banco o `FOREIGN KEY (reference_transaction_id, wallet_id)` impede que um ROLLBACK da wallet B ocupe o slot de reversão de uma BET da wallet A, enquanto o trigger `wager_transactions_guard` garante que `reference_external_transaction_id` e `provider_id` batem com a linha apontada por `reference_transaction_id`, que um `REFUND` `PROCESSED` só aponta para `BET` `PROCESSED` e que um `ROLLBACK` `PROCESSED` só aponta para `BET`, `WIN` ou `REFUND` `PROCESSED`.

## Idempotência

### O hash

O `payloadHash` é o sha256 de um JSON canônico (chaves ordenadas, sem espaço) destes campos, já normalizados pelo use case:

```
providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
money { amount normalizado ("10.00"), currency }, referenceExternalTransactionId (null quando ausente)
```

Header e metadado de transporte não entram, então a mesma operação tem o mesmo hash por HTTP e por SQS. As garantias ficam no banco: `UNIQUE(provider_id, idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`. Mesma key com hash igual é replay, com hash diferente é 409 `IDEMPOTENCY_CONFLICT`, e o mesmo `externalTransactionId` com outra key é 409 `DUPLICATE_EXTERNAL_TRANSACTION`.

Quando duas requisições com a mesma key chegam em wallets diferentes, o lock da wallet não serializa as duas, e quem resolve é o `UNIQUE`. A perdedora recebe `23505`, faz rollback, abre uma transação nova, relê a decisão vencedora e compara o hash, devolvendo replay ou 409.

### Header vs `data.idempotencyKey`

Na HTTP a fonte da verdade é o header `Idempotency-Key`, que é obrigatório. No SQS não tem header de negócio, então a fonte da verdade é o `data.idempotencyKey` da mensagem. As duas caem no mesmo namespace `(provider_id, idempotency_key)`, e a mesma transação mandada pelos dois canais tem um efeito só.

O inbox do SQS usa outro hash (`hashMessage`), que é o mesmo payload **mais** o `idempotencyKey`. Como no SQS a key está dentro do corpo, uma mensagem que reaproveita o `messageId` com outra key é outra mensagem, e precisa ser pega como `inbox_payload_mismatch` (DLQ) e não confundida com redelivery.

## Atomicidade e outbox

Saldo, transação, lançamento no ledger, inbox (no SQS) e eventos na outbox são gravados na **mesma transação SQL**. Nada é publicado dentro dela, e o teste de atomicidade injeta falha no insert da outbox, no insert do ledger e logo antes do commit, e confere que wallet, transações, ledger e outbox ficaram exatamente como estavam.

O worker de outbox faz claim com lease (`OUTBOX_LEASE_MS`) e `FOR UPDATE SKIP LOCKED`, publica em `wagering-events.fifo` com `MessageGroupId = aggregateId` (o `walletId`) e `MessageDeduplicationId = eventId`, e só então marca como publicado. Se o processo morrer entre o publish e o mark, outra instância pega o lease vencido e publica de novo com o mesmo `eventId`.

### Head-of-line por `seq`

Para os eventos de uma wallet saírem na ordem do commit, o claim é head-of-line por agregado: só é elegível a mensagem mais antiga não publicada de cada wallet. "Mais antiga" é pelo `outbox_messages.seq` (`bigserial`), e o ponto é que ele é sorteado no `INSERT`, que acontece com a wallet travada, então por wallet o `seq` cresce na ordem do commit. Se eu ordenasse por `occurred_at`, que vem do relógio de cada instância, duas réplicas com relógios levemente diferentes poderiam inverter a ordem de dois eventos da mesma wallet. O trade-off é que uma mensagem que não consegue ser publicada segura os eventos seguintes daquela wallet, e nunca é descartada: depois de `OUTBOX_MAX_ATTEMPTS` ela continua tentando no intervalo máximo e conta na métrica de alerta `outbox_attempts_exhausted_total`.

### Dedup do FIFO e o consumidor

A deduplicação do SQS FIFO por `MessageDeduplicationId` só vale numa janela de **5 minutos**. Uma republicação depois de uma queda mais longa passa, então a dedup do FIFO é otimização e não garantia. A garantia é o consumidor downstream deduplicar por `eventId` e ordenar os eventos de uma wallet pelo `walletVersion`, nunca pela chegada. O `tests/support/test-event-consumer.ts` faz exatamente isso, e as suítes usam ele para provar que todo evento sai pelo menos uma vez e que duplicata tem o mesmo `eventId`.

## SQS: consumer de comandos

O consumer faz long polling em `wager-transactions.fifo`, processa as mensagens de um mesmo `MessageGroupId` em ordem e grupos diferentes em paralelo, e mantém um heartbeat de visibilidade enquanto a mensagem não é resolvida. O ack (`DeleteMessage`) só acontece depois que o handler resolveu, ou seja, depois do commit. Um crash entre o commit e o ack faz a mensagem voltar, e o inbox `(consumer_name, message_id)` transforma isso num replay sem efeito novo.

Como cada erro é tratado:

| Erro | Destino |
| --- | --- |
| regra de negócio (`REJECTED`, `WALLET_NOT_FOUND`, conflito de idempotência) | ack, a rejeição é a resposta |
| transitório (lock timeout, deadlock, banco fora, timeout do handler) | retry dentro do processo, com backoff |
| permanente (JSON inválido, schema, `OPENING`, mesmo `messageId` com outro payload) | `SendMessage` explícito na DLQ e `DeleteMessage` |
| desconhecido | retry, e DLQ como `retries_exhausted` quando acabam as tentativas |

### Retry dentro do processo, e só as falhas da própria mensagem contam

O caminho óbvio seria deixar o SQS reentregar e usar o `maxReceiveCount` do redrive como limite de tentativas. O problema é que o `ApproximateReceiveCount` conta **entregas**, não falhas: o restante de um grupo devolvido junto com a cabeça, ou um lote devolvido num deploy, ganha receive sem nunca ter falhado, e uma decisão em cima desse número mandaria para a DLQ um comando que nem foi processado. Então o retry fica no processo: a mensagem que falhou é tentada de novo ali mesmo, com backoff (`SQS_CONSUMER_RETRY_BASE_MS`, `SQS_CONSUMER_RETRY_CAP_MS`), enquanto o heartbeat segura ela e o resto do grupo invisíveis, e depois de `SQS_CONSUMER_MAX_IN_PROCESS_ATTEMPTS` (8) falhas seguidas dela mesma vai para a DLQ de forma explícita.

O redrive continua configurado, mas como rede de segurança para um consumer que morre antes de resolver a mensagem, e o `maxReceiveCount` fica em 100, bem acima do que deploys e paradas conseguem acumular. Ele não é o limite de retry.

### Circuit breaker e timeout do handler

Depois de cada falha o consumer roda o probe de readiness do PostgreSQL antes de tentar de novo. Com o banco fora, a falha não conta para a mensagem e o handler não é chamado até o probe passar, e o circuit breaker (`CIRCUIT_BREAKER_FAILURE_THRESHOLD=3`, `CIRCUIT_BREAKER_OPEN_MS=5000`) espaça esses probes. Sem isso, uma queda do banco de alguns minutos queimaria as tentativas de mensagens válidas e mandaria tudo para a DLQ. O breaker é alimentado pelo probe e não pelo erro da mensagem, então um lock timeout numa wallet quente não pausa o consumer inteiro.

Um banco congelado (`docker pause`, partição de rede) não devolve erro, ele só para de responder, e a tentativa ficaria pendurada para sempre sem nunca chegar no probe. Por isso cada tentativa tem teto de `SQS_CONSUMER_HANDLER_TIMEOUT_MS` (15s) e, passado ele, conta como falha transitória. A tentativa abandonada ainda pode commitar depois, e aí o retry encontra o inbox processado e faz replay.

### SIGTERM

No `SIGTERM` o processo para o polling, deixa as mensagens em andamento terminarem até `SHUTDOWN_TIMEOUT_MS` (25s), devolve com visibilidade 0 as que foram recebidas e não começaram, devolve a que estava esperando retry com a visibilidade do backoff, fecha o pool e sai com 0. O que sobrar sem resolver reaparece quando a visibilidade vence.

## Limitações do LocalStack

**Bloqueio de grupo FIFO.** Na AWS, um grupo com mensagem em voo não entrega mais nada daquele grupo. O LocalStack 4.4.0 não respeita isso e entrega uma mensagem do grupo enquanto a mais antiga ainda está em voo. Por isso o restante do grupo volta com a mesma visibilidade da cabeça, e não com 0, e os testes de ordem contra o LocalStack rodam com um consumer só.

**Receipt handle.** O LocalStack expira o receipt handle em "momento do receive + última visibilidade definida", então uma extensão simples de visibilidade faria o `DeleteMessage` final falhar com "The receipt handle has expired". O heartbeat define a visibilidade como o timeout mais o tempo já gasto desde o receive, o que na AWS só segura a mensagem um pouco mais depois de um crash e no LocalStack é obrigatório.

**Host do `QueueUrl`.** O `QueueUrl` devolvido usa o `LOCALSTACK_HOST`, que dentro da rede do compose não resolve, então o cliente usa `endpoint` configurável e `useQueueUrlAsEndpoint: false`. Os detalhes estão em [`docs/spikes/localstack.md`](docs/spikes/localstack.md).

## Limitações do Bun

O Nest roda no Bun pela camada de compatibilidade com Node, com o adapter Express. Funcionou para tudo o que o projeto usa (decorators com `emitDecoratorMetadata`, class-validator, Swagger), mas não é a plataforma oficial do Nest, então uma lib do ecossistema Nest que dependa de algo específico do Node pode quebrar sem aviso.

O OTel ficou de fora. A auto-instrumentação do `@opentelemetry` se apoia nos hooks de carregamento de módulo do Node, e acredito que no Bun ela não funcione por completo, mas eu não cheguei a validar. Se entrar, a ideia é instrumentar por decorators na infraestrutura, do mesmo jeito que métricas e logs, sem depender da auto-instrumentação.

## TypeScript 7 (compilador nativo)

O Bun transpila `.ts` sozinho para rodar a aplicação e os testes, mas não checa tipos. Quem garante `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` e os decorators é o `bun run typecheck`, e ele roda no **TypeScript 7.0.2**, o compilador nativo em Go (pacote `@typescript/native`, apelido de `typescript@7.0.2`).

Medi o `--noEmit -p tsconfig.json` nesta máquina, três execuções de cada, com o cache quente:

| Compilador | Tempo |
| --- | --- |
| TypeScript 6.0.3 (`tsc` em JavaScript) | ~2,4 s |
| TypeScript 7.0.2 (nativo) | ~0,4 s |

O ganho fica perto de **6x**. O número exato muda com a máquina e com o cache, então o que vale guardar é a ordem de grandeza.

O TypeScript 7 ainda não expõe a API JavaScript (`import * as ts from 'typescript'`), e o `typescript-eslint` depende dela. Por isso o projeto mantém os dois instalados, cada um no seu papel:

`@typescript/native` (7.0.2) -> só o `typecheck`.
`typescript` (6.0.3, via `@typescript/typescript6`) -> só o parser do `typescript-eslint`, no `bun run lint`.

Cheguei a testar um lint sem o TypeScript 6, rodando o ESLint sobre o JavaScript gerado pelo `Bun.Transpiler`. As regras de dinheiro continuavam passando, mas as regras de TypeScript sumiam, a linha do erro deixava de bater com o `.ts` e os metadados de decorator precisavam de um ajuste por regex. Para um projeto em que o lint é uma das barreiras contra `number` em dinheiro, preferi o lint estável. Quando o TypeScript 7 publicar a API e o `typescript-eslint` passar a suportá-la, o TypeScript 6 sai. O `dependency-cruiser` lê os imports com o parser do SWC (`parser: 'swc'`) e não depende de nenhuma das duas versões.

## Auth

O enunciado deixa a auth fora da pontuação, então eu comecei pelo ponto de extensão: o port `IProviderIdentity` e um guard global. O `providerId` autenticado entra no use case como `actor`, e a regra `PROVIDER_IDENTITY_MISMATCH` (body ou path com outro `providerId`) fica no domínio e sai como **403**.

`AUTH_MODE=noop` -> `DevProviderIdentity`, o padrão. Aceita `Authorization: Bearer dev:<providerId>` e não prova nada. Serve para desenvolvimento e para os testes.
`AUTH_MODE=jwks` -> `JwksProviderIdentity`, com `jose`. Verifica a assinatura contra o JWKS do Keycloak, `iss`, `aud` e `exp`/`nbf`, e tira o provedor da claim `provider_id`. Cada provedor é um client confidencial `client_credentials` no realm `wagering`. Toda recusa é o mesmo 401 para quem chamou, e o motivo só vai para o log. Se o JWKS não puder ser buscado, o IdP está fora, o que não diz nada sobre o token, então é 503 e não 401.

O Keycloak fica no profile `auth` para não pesar nos testes e na carga. Health, `/metrics`, `/docs` e `/i18n` ficam abertos.

O `PROVIDER_IDENTITY_MISMATCH` **não é persistido**. Se fosse, um provedor mal-intencionado gravaria uma linha no namespace `(provider_id, idempotency_key)` de outro provedor, e a requisição legítima depois esbarraria num replay ou num 409 que ela não causou.

No SQS não existe token. O enunciado trata a fila como canal interno confiável, mas pede que a identidade do provedor na mensagem passe pelas mesmas validações. O consumer lê o `actorProviderId` dos atributos da mensagem (`MessageAttributes.providerId`) ou do envelope e o passa como `actor`. Se ele divergir de `data.providerId`, a regra `PROVIDER_IDENTITY_MISMATCH` do use case recusa, e a mensagem recebe ack sem gravar nada. Sem o atributo, o `actor` passa a ser o próprio `data.providerId`.

Isso não autentica ninguém. Quem publica na fila escolhe os dois valores, então a checagem só pega o produtor que se contradiz. A proteção real do canal é a permissão de escrita na fila (IAM na AWS). Se o canal deixar de ser confiável, o caminho é assinar a mensagem ou exigir o atributo e ligá-lo à credencial de quem publicou.

## O que não é persistido, e as colunas geradas

`WALLET_NOT_FOUND` -> 404 na HTTP, e nada é gravado: não tem wallet para a FK apontar. O inbox também não é marcado, então no SQS a mensagem recebe ack como erro de negócio, com log e métrica, e o provedor pode reenviar depois que a wallet existir. Um `PENDING_REFERENCE` cuja wallet some vira `FAILED` no worker.
`PROVIDER_IDENTITY_MISMATCH` -> 403 e nada gravado, pelo motivo acima.
Validação (400) e conflito de idempotência (409) -> nada gravado.

As outras rejeições são persistidas para o replay continuar respondendo 422. Duas delas quebrariam as FKs compostas, e a saída foi usar colunas geradas:

`wager_transactions.wallet_currency` -> `NULL` só quando `failure_code = 'CURRENCY_MISMATCH'`, e igual a `currency` no resto. A FK `(wallet_id, wallet_currency) → wallets(id, currency)` é `MATCH SIMPLE`, então ela é pulada só nessa rejeição e obriga a moeda da wallet em todas as outras linhas.
`wager_transactions.wallet_player_id` -> mesma ideia para `WALLET_PLAYER_MISMATCH`, que fica gravado com o jogador que o provedor mandou.

## Envelope e i18n

Toda resposta de negócio sai no mesmo envelope `{ code, message, data, timestamp, detailsMessage[] }`, em que `data` é o payload do enunciado sem alteração e cada item de `detailsMessage` tem um `code` estável (o `FailureCode` ou a regra de validação), uma `message` que é uma chave i18n (`WAGERING.ERROR.INSUFFICIENT_FUNDS`), o `field` e o `type`. O backend não traduz, o front traduz pelo catálogo do `GET /i18n`.

O motivo é o provedor decidir o que fazer pelo código e não pelo texto: reenviar num 503, desistir num 422, corrigir o payload num 400, sem interpretar frase nenhuma. Como a chave fica separada do código, dá para trocar texto ou acrescentar idioma sem mexer no contrato, uma validação devolve todos os campos inválidos de uma vez, e o mesmo erro aparece igual no log, na métrica e na tela. Um teste falha se algum `FailureCode` ficar sem mensagem. O mapeamento completo de erro para status está em [`docs/http-contract.md`](docs/http-contract.md).

## Deploy

`APP_ROLES` -> uma imagem só, e cada container escolhe o que roda entre `api`, `consumer`, `outbox` e `pending-worker` (vazio é tudo). O compose sobe 3 réplicas com todos os papéis, e a solução é testada assim em `test:multi`. Em produção dá para separar, por exemplo réplicas só de `api` e um grupo menor de workers, sem outro build.
`bun run migrate` -> roda uma vez antes das réplicas (serviço `migrate` no compose). A aplicação não migra sozinha, para três réplicas não disputarem a mesma migration.
`HTTP_REQUEST_TIMEOUT_MS` -> 10s por padrão. Passado isso a resposta é 503 + `Retry-After`, mas o trabalho não é cancelado. Se ele commitar depois, o retry do provedor com a mesma `Idempotency-Key` recebe o replay, então o timeout nunca gera efeito duplicado.
`stop_grace_period: 30s` -> o consumer espera até `SHUTDOWN_TIMEOUT_MS` (25s) para terminar o que está em voo, e o padrão do Docker é 10s, então com o padrão o `SIGKILL` chegaria antes. O worker de pendências termina só o item em que está, o pior caso dele é 2 × `DB_LOCK_TIMEOUT_MS`, e o resto volta quando o lease vence.
NTP -> o claim do worker de pendências usa o `IClock` da instância e não o `now()` do banco, porque é ele que deixa os testes andarem no tempo com `FakeClock` e é o mesmo relógio que agenda o `next_attempt_at` no fluxo HTTP/SQS. A premissa é que **todas as instâncias têm o relógio sincronizado por NTP**. Com um desvio maior que o menor atraso do backoff (2s), uma instância adiantada enxerga o lease das outras como vencido antes da hora. O status reconferido sob o lock impede liquidar o item duas vezes, mas a tentativa pode ser contada duas vezes e o item chegar no `REFERENCE_NOT_FOUND` antes dos ~5 minutos.

## Desvios do enunciado e limitações conhecidas

O OTel, que era diferencial opcional, ficou de fora.
`BALANCE_LIMIT_EXCEEDED` é um `FailureCode` a mais, para o crédito acima do máximo do `Money` ser rejeição e não erro 500.
As respostas HTTP vêm dentro do envelope. O payload do enunciado está inteiro em `data`.
No SQS a identidade do provedor não é autenticada, só checada contra o próprio payload. A garantia é a permissão de escrita na fila.
O head-of-line da outbox troca vazão por ordem: uma mensagem que não publica segura os eventos seguintes daquela wallet até sair.
A DLQ não tem redrive automático. Uma mensagem que caiu lá por falha permanente de infraestrutura pode ser válida, e o reenvio é manual, depois de entender a causa (esse caso sai no log como `error`, com o `sqlState`).
O `ApproximateReceiveCount` não é usado como limite, então um consumer que morre repetidamente antes de resolver a mesma mensagem só manda ela para a DLQ pelo redrive, depois de 100 entregas.
O worker de pendências depende de NTP, como descrito acima.
Os testes de ordem FIFO contra o LocalStack rodam com um consumer só, porque ele não bloqueia o grupo como a AWS.
