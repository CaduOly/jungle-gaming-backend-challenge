# Contrato HTTP

Todos os endpoints respondem no mesmo envelope, e as mensagens saem como **chaves i18n**. O backend não traduz, quem traduz é o front.

## Por que esse formato

O objetivo é tornar o mapeamento de erros e mensagens previsível para quem consome a API:

- **Uma estrutura só.** O cliente usa o mesmo parser em qualquer endpoint, de sucesso ou de erro, sem caso especial.
- **Decisão pelo código, não pelo texto.** O provedor decide o que fazer, como reenviar, desistir ou corrigir o payload, a partir de `code` (o status) e de `detailsMessage[].code` (o `FailureCode`). Os dois são estáveis. Ninguém precisa interpretar uma frase para saber se pode tentar de novo.
- **Mensagem desacoplada do código.** A chave i18n fica separada do código de erro. Dá para trocar o texto ou acrescentar um idioma sem mexer no contrato, e o mesmo erro aparece igual no log, na métrica e na tela.
- **Vários problemas numa resposta.** Uma validação devolve todos os campos inválidos de uma vez, cada um com o seu `field`.
- **Catálogo verificável.** Todo código tem uma chave, e um teste garante que nenhum `FailureCode` fica sem mensagem.

## Envelope

Vale para sucesso e erro em todos os endpoints de negócio. Health (`/health/*`) e `/metrics` ficam fora: são consumidos por probe e pelo Prometheus e respondem no formato cru.

```json
{
  "code": 422,
  "message": "UNPROCESSABLE_ENTITY",
  "data": { },
  "timestamp": 1761570000000,
  "detailsMessage": [
    {
      "code": "INSUFFICIENT_FUNDS",
      "message": "WAGERING.ERROR.INSUFFICIENT_FUNDS",
      "field": "money.amount",
      "type": "error"
    }
  ]
}
```

| Campo | Regra |
| --- | --- |
| `code` | Número igual ao status HTTP. |
| `message` | Nome do status no catálogo `Code` (`SUCCESS`, `CREATED`, `ACCEPTED`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `UNPROCESSABLE_ENTITY`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`). |
| `data` | O payload descrito no enunciado (`docs/CHALLENGE.md` §9), sem alteração. Também vai preenchido em 422 de replay e em 202 (transação e saldo observado). |
| `timestamp` | Epoch em milissegundos, vindo do `IClock`. |
| `detailsMessage[]` | Lista vazia no sucesso. No erro, cada item tem `code` estável, `message` com a chave i18n, `field` opcional (caminho do campo) e `type` (`error` ou `warning`). |

## Catálogo de mensagens (i18n)

- O catálogo fica em `src/infrastructure/framework/nest/shared/i18n/`, em classes `*.detail-message.ts` com campos `static` do tipo `IDetailMessage`.
- Chaves no formato `WAGERING.ERROR.<CODE>`, `WALLET.ERROR.<CODE>`, `VALIDATION.ERROR.<RULE>` e `INFRA.ERROR.<CODE>`.
- Cada `FailureCode` do domínio tem uma entrada, incluindo o `BALANCE_LIMIT_EXCEEDED` (o crédito passaria do máximo do Money). O `code` do detail é o próprio FailureCode.
- Cada `InputRule` do domínio (regra de entrada que só a entidade conhece, como `AMOUNT_MUST_BE_POSITIVE` e `REFERENCE_REQUIRED`) tem uma entrada `VALIDATION.ERROR.<RULE>`. O mapeamento é um `Record<InputRule, …>`: regra nova sem mensagem não compila.
- Há um teste que falha se algum `FailureCode` não tiver entrada, ou se algum `code` estiver duplicado.
- `GET /i18n` devolve o catálogo completo, para o front montar as traduções. Não exige autenticação.
- O domínio não conhece chave i18n. A tradução de `FailureCode` para detail acontece no filter.

## Mapeamento erro → status

| Origem | Status | `detailsMessage[].code` |
| --- | --- | --- |
| PROCESSED | 200 | vazio |
| Criado (wallet) | 201 | vazio |
| PENDING_REFERENCE | 202 | `REFERENCE_PENDING` (warning) |
| Validação (DTO, Money, UUID, cursor, `Idempotency-Key` ausente, OPENING pela API, regra da entidade como BET `0.00` ou REFUND sem referência) | 400 | um item por campo, com `field` |
| Chave `__proto__`, `constructor` ou `prototype` em qualquer nível do body | 400 | `FORBIDDEN_KEY`, com o caminho em `field` |
| Body que não é JSON válido, ou que aninha objetos e arrays em mais de 32 níveis | 400 | `MALFORMED_BODY` |
| URI com percent-encoding quebrado (`/wallets/%E0%A4%A`) | 400 | `MALFORMED_PATH`, com `field: "path"` |
| Sem token / token inválido | 401 | `UNAUTHORIZED` |
| `PROVIDER_IDENTITY_MISMATCH` (body ou path com outro `providerId`) | 403 | `PROVIDER_IDENTITY_MISMATCH` |
| Wallet ou transação inexistente | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| Transação de outro provider buscada por id (`GET /wagering/transactions/:id`) | 404 | `TRANSACTION_NOT_FOUND`. A resposta é idêntica à de um id inexistente: a API não confirma que a transação existe. |
| `IDEMPOTENCY_CONFLICT`, `DUPLICATE_EXTERNAL_TRANSACTION`, wallet duplicada | 409 | o próprio código |
| Body acima do limite (`HTTP_BODY_LIMIT`, padrão `100kb`) | 413 | `PAYLOAD_TOO_LARGE` |
| Body que não é JSON (`Content-Type` diferente de `application/json`, com ou sem `charset`) | 415 | `UNSUPPORTED_MEDIA_TYPE`. O parser só lê `application/json`, então `application/merge-patch+json` e outros `application/*+json` também caem aqui. Vale só para as rotas que leem body (`POST /wallets` e `POST /wagering/transactions`). As demais, inclusive a reconciliação, ignoram o body que chegar, até um `Transfer-Encoding: chunked` vazio. |
| REJECTED (demais FailureCodes, incluindo `BALANCE_LIMIT_EXCEEDED`) | 422 | o FailureCode |
| Transitório (DB fora, lock timeout, deadlock) | 503 + `Retry-After` | `INFRA_UNAVAILABLE` |
| Erro desconhecido | 500 | `INTERNAL_ERROR`. Stack e mensagem interna não vazam para o corpo. |

O replay devolve o mesmo status do original, com `data.idempotentReplay: true`.

## Validação

- DTOs HTTP usam class-validator. Cada decorator carrega o `IDetailMessage` no `context`.
- Um `ValidationPipe` global converte `ValidationError[]` em `detailsMessage[]`, com o caminho do campo e a descida em objetos aninhados.
- Dinheiro chega como string. A regra de formato é do Money (`Money.isValidAmount` e `Money.isValidCurrency`, as mesmas que o `Money.from` usa), e o DTO aplica cada uma no seu campo. Amount e currency são conferidos de forma independente: `{ "amount": "1", "currency": "brl" }` devolve `money.amount` e `money.currency`.
- Todos os campos inválidos saem numa resposta só. Os details do DTO e do Money vêm juntos, e o `POST /wagering/transactions` valida o body e o header `Idempotency-Key` no mesmo passo: faltando o header com o body também inválido, voltam os dois.
- O que só a entidade sabe validar (BET `0.00`, REFUND/ROLLBACK sem referência, BET com referência, autorreferência) vem do domínio com o caminho do campo e uma `InputRule` estável, e vira detail com `field` (`money.amount`, `referenceExternalTransactionId`). Nada sai com `field: "payload"`.
- O body é recusado com `MALFORMED_BODY` se aninhar objetos ou arrays em mais de 32 níveis. A conferência é iterativa e roda antes de qualquer etapa que percorra o body de forma recursiva (class-transformer, class-validator e a busca de chaves proibidas), então um body como `{"a":[[[…]]]}` com milhares de níveis não estoura a pilha.
- O body é recusado com `FORBIDDEN_KEY` se tiver `__proto__`, `constructor` ou `prototype` em qualquer nível, antes de qualquer cópia para objeto (o `JSON.parse` mantém `__proto__` como chave própria).

## Health

Os dois endpoints são abertos (sem token) e respondem cru, sem envelope.

| Endpoint | Resposta |
| --- | --- |
| `GET /health/live` | `200 { "status": "ok" }` enquanto o processo responde. |
| `GET /health/ready` | `200 { "instanceId": "…", "roles": ["api", "consumer", "outbox", "pending-worker"], "circuitBreaker": "closed", "status": "ready", "checks": { "postgres": "up", "sqs": "up" } }` quando todos os checks respondem. `503 { "status": "unavailable", "checks": { … "down" } }` quando algum falha, com o nome de quem caiu. |

- Os checks implementam o port de infra `IReadinessCheck` e entram na montagem do app. Em produção são o `PostgresReadinessCheck` (`SELECT 1` no pool) e o `SqsReadinessCheck` (`GetQueueAttributes` na fila).
- Cada check tem um teto de `HEALTH_READINESS_TIMEOUT_MS` (padrão 1000). Um check travado conta como `down` dentro do prazo, e o probe não fica pendurado.
- Sobre os fakes em memória não há dependência para checar, então o `/health/ready` responde 200.

## Swagger

- UI em `GET /docs` e spec OpenAPI 3 em `GET /docs-json`, com `addBearerAuth`.
- Toda rota documenta o sucesso **e todos os erros possíveis**. Um decorator composto por endpoint junta isso, por exemplo `@ApiWagerTransactionResponses()`. As rotas com body também documentam 413 e 415.
- Schemas reutilizáveis: `ApiResponseEnvelope<T>` (com `data` tipado) e `DetailMessageDto`.
- Cada status tem pelo menos um exemplo nomeado: `insufficientFunds`, `idempotencyConflict`, `pendingReference`, `serviceUnavailable` etc.
- O header `Idempotency-Key` aparece como obrigatório. Dinheiro aparece como `string` com `pattern: ^(0|[1-9]\d{0,17})\.\d{2}$`, nunca como `number`.
- Um teste gera o documento e confere que toda rota registrada no Nest aparece no spec com os status da tabela acima.
- Os decorators do Swagger ficam só nos DTOs de `infrastructure/framework/nest`. O business não recebe nenhum.
