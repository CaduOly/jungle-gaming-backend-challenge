# Spike — LocalStack SQS FIFO sem auth token

Data: 2026-10-27. Status: **aprovado**, LocalStack segue como SQS local. MiniStack (plano B) não foi necessário.

## Pergunta

1. A tag escolhida sobe sem `LOCALSTACK_AUTH_TOKEN`? As versões recentes do LocalStack passaram a exigir conta.
2. O redrive de uma fila FIFO para a DLQ FIFO funciona com `maxReceiveCount = 5`?

## Escolha

| Item | Valor |
| --- | --- |
| Imagem | `localstack/localstack:4.4.0` |
| Digest | `sha256:b52c16663c70b7234f217cb993a339b46686e30a1a5d9279cb5feeb2202f837c` |
| Postgres | `postgres:17.6-alpine` (`sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94`) |

A 4.4.0 foi validada na prática: sobe e atende SQS sem token. A tag é fixa no
`docker-compose.yml` para não subir sozinha para uma versão que pede conta.

## Resultado

- O container sobe com `SERVICES=sqs`, sem nenhuma variável de auth, e o log não menciona licença nem token.
- O script `infra/localstack/init-sqs.sh` (hook `ready.d`) cria:
  - `wagering-commands.fifo` → `wagering-commands-dlq.fifo`
  - `wagering-events.fifo` → `wagering-events-dlq.fifo`
  - todas FIFO, `ContentBasedDeduplication=false`, redrive com `maxReceiveCount=5`.
- O healthcheck do compose só fica verde depois do init (`/_localstack/init/ready` com `completed: true`).
- Redrive: 5 receives sem delete devolvem `ApproximateReceiveCount` 1..5. No 6º receive a fila principal vem
  vazia e a mensagem aparece na DLQ com `ApproximateReceiveCount=6` e
  `DeadLetterQueueSourceArn` apontando para a fila de origem.
  O LocalStack move a mensagem no receive que ultrapassa o limite, igual à AWS.

## Como reproduzir

Automatizado (fila isolada com sufixo único, não mexe nas filas compartilhadas):

```bash
bun run infra:up
bun test ./tests/integration/infra/sqs-redrive.spec.ts
```

Manual, contra as filas do compose:

```bash
docker compose exec -T localstack bash -c '
Q=$(awslocal sqs get-queue-url --queue-name wagering-commands.fifo --query QueueUrl --output text)
D=$(awslocal sqs get-queue-url --queue-name wagering-commands-dlq.fifo --query QueueUrl --output text)
awslocal sqs send-message --queue-url $Q --message-body spike --message-group-id g1 --message-deduplication-id spike-$RANDOM
for i in 1 2 3 4 5 6; do
  awslocal sqs receive-message --queue-url $Q --visibility-timeout 0 --attribute-names ApproximateReceiveCount \
    --query "Messages[0].Attributes.ApproximateReceiveCount" --output text
done
awslocal sqs receive-message --queue-url $D --attribute-names All'
```

Saída observada: `1 2 3 4 5 None`, e a DLQ devolve a mensagem `spike`.

## Pontos de atenção para as próximas tasks

- O `QueueUrl` devolvido usa o host de `LOCALSTACK_HOST` (`localhost:<porta do host>`). Dentro da rede do
  compose esse host não resolve, então o cliente SQS da app precisa de `endpoint` configurável e
  `useQueueUrlAsEndpoint: false` (o helper `createSqsClient` dos testes já faz assim).
- O receive com `VisibilityTimeout=0` é o jeito determinístico de forçar redeliveries nos testes, sem `sleep`.
- A deduplicação FIFO tem janela de 5 minutos também no LocalStack: os testes usam `MessageDeduplicationId` UUIDv7.
