# Contrato HTTP (T08)

Segue o padrão das APIs do time (`financial-integration`): envelope único em todos os endpoints e mensagens como **chaves i18n**. O backend não traduz, quem traduz é o front.

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
| `message` | Nome do status no catálogo `Code` (`SUCCESS`, `ACCEPTED`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `UNPROCESSABLE_ENTITY`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`). |
| `data` | O payload descrito no README §9, sem alteração. Também vai preenchido em 422 de replay e em 202 (transação e saldo observado). |
| `timestamp` | Epoch em milissegundos, vindo do `IClock`. |
| `detailsMessage[]` | Lista vazia no sucesso. No erro, cada item tem `code` estável, `message` com a chave i18n, `field` opcional (caminho do campo) e `type` (`error` ou `warning`). |

## Catálogo de mensagens (i18n)

- O catálogo fica em `src/infrastructure/framework/nest/shared/i18n/`, em classes `*.detail-message.ts` com campos `static` do tipo `IDetailMessage`.
- Chaves no formato `WAGERING.ERROR.<CODE>`, `WALLET.ERROR.<CODE>`, `VALIDATION.ERROR.<RULE>` e `INFRA.ERROR.<CODE>`.
- Cada um dos 14 `FailureCode`s do domínio tem uma entrada. O `code` do detail é o próprio FailureCode.
- Há um teste que falha se algum `FailureCode` não tiver entrada, ou se algum `code` estiver duplicado.
- `GET /i18n` devolve o catálogo completo, para o front montar as traduções. Não exige autenticação.
- O domínio não conhece chave i18n. A tradução de `FailureCode` para detail acontece no filter.

## Mapeamento erro → status

| Origem | Status | `detailsMessage[].code` |
| --- | --- | --- |
| PROCESSED | 200 | vazio |
| Criado (wallet) | 201 | vazio |
| PENDING_REFERENCE | 202 | `REFERENCE_PENDING` (warning) |
| Validação (DTO, Money, UUID, cursor, `Idempotency-Key` ausente, OPENING pela API) | 400 | um item por campo, com `field` |
| Sem token / token inválido | 401 | `UNAUTHORIZED` |
| `PROVIDER_IDENTITY_MISMATCH` | 403 | `PROVIDER_IDENTITY_MISMATCH` |
| Wallet ou transação inexistente | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| `IDEMPOTENCY_CONFLICT`, `DUPLICATE_EXTERNAL_TRANSACTION`, wallet duplicada | 409 | o próprio código |
| REJECTED (demais FailureCodes) | 422 | o FailureCode |
| Transitório (DB fora, lock timeout, deadlock) | 503 + `Retry-After` | `INFRA_UNAVAILABLE` |
| Erro desconhecido | 500 | `INTERNAL_ERROR`. Stack e mensagem interna não vazam para o corpo. |

O replay devolve o mesmo status do original, com `data.idempotentReplay: true`.

## Validação

- DTOs HTTP usam class-validator. Cada decorator carrega o `IDetailMessage` no `context`.
- Um `ValidationPipe` global converte `ValidationError[]` em `detailsMessage[]`, com o caminho do campo e a descida em objetos aninhados.
- Dinheiro chega como string. O DTO só confere o tipo, e a regra de formato fica no `Money.from`. O erro do Money vira detail `VALIDATION.ERROR.INVALID_MONEY_AMOUNT` com `field`.

## Swagger

- UI em `GET /docs` e spec OpenAPI 3 em `GET /docs-json`, com `addBearerAuth`.
- Toda rota documenta o sucesso **e todos os erros possíveis**. Um decorator composto por endpoint junta isso, por exemplo `@ApiWagerTransactionResponses()`.
- Schemas reutilizáveis: `ApiResponseEnvelope<T>` (com `data` tipado) e `DetailMessageDto`.
- Cada status tem pelo menos um exemplo nomeado: `insufficientFunds`, `idempotencyConflict`, `pendingReference`, `serviceUnavailable` etc.
- O header `Idempotency-Key` aparece como obrigatório. Dinheiro aparece como `string` com `pattern: ^(0|[1-9]\d{0,17})\.\d{2}$`, nunca como `number`.
- Um teste gera o documento e confere que toda rota registrada no Nest aparece no spec com os status da tabela acima.
- Os decorators do Swagger ficam só nos DTOs de `infrastructure/framework/nest`. O business não recebe nenhum.
