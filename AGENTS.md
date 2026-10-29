# Regras do projeto para agentes

Este arquivo é versionado só na `dev`. Ele **nunca** vai para a `main`.

## Fontes de verdade

- Enunciado: `README.md`.
- Plano técnico: arquivo local do Carllos, fora do repositório. As decisões dele estão registradas em `ARCHITECTURE.md` e `docs/`.
- Épico e tasks: `docs/EPIC.md`.

## Git

- `main` é **exclusiva do Carllos**. Nenhum agente faz commit, merge, rebase ou push na `main`.
- Integração na `dev`. Cada task tem a própria branch `feat/TXX-<slug>`, criada a partir da `dev`.
- O merge na `dev` é feito pelo tech lead, **só depois da aprovação do QA**, com `--no-ff`.
- Push só da `dev`, pela conta GitHub `CaduOly`.
- Sem force push, sem reescrever histórico já publicado e sem apagar branch remota.
- Autor dos commits: `cadu.oliveira2444@gmail.com`, já na config local. Não alterar.
- **Proibido** qualquer assinatura ou menção a ferramentas de IA em commits e PRs, como linhas `Co-Authored-By`. Antes de entregar, confira: `git log dev..HEAD --format=%B | grep -i co-authored-by` não pode retornar nada.
- Mensagens de commit em inglês, no formato Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`).

## Fluxo do time

Estratégia em vigor desde 29/10, a pedido do Carllos:

1. Os devs fecham o **MVP** de todas as tasks restantes, em TDD, com as suítes verdes em cada commit.
2. Com o MVP completo, o **QA valida tudo de uma vez**.
3. Bug encontrado: o QA reporta ao tech lead, que devolve ao dev responsável. Depois da correção, o QA valida de novo.
4. Com o QA aprovado, vem o merge na `dev` e o push.

## Ambiente

- Bun em `~/.bun/bin/bun`: `export PATH=$HOME/.bun/bin:$PATH`.
- O stack do compose (`name: jungle-wagering`) é compartilhado. Cada execução de teste cria um banco e filas com sufixo único. Não derrube o stack de outro dev.
- Não mexer nos containers MySQL de outros projetos (portas 25578/25580).
- O stack do compose **só sobe pelo checkout principal**, nunca por um worktree. Os bind mounts apontam para o diretório de onde o compose rodou. Só o tech lead recria containers.
- Specs (de fakes, contratos e builders) em `tests/support` rodam no `bun run test`. Teste que nenhum script executa é teste morto.
- Worktrees das tasks ficam em `/home/carllos-eduardo/workspace/estudos/jungle-wt/<TASK>`, nunca em `/tmp`, porque um reboot apaga o `/tmp`.
- **Commite com frequência**, a cada passo verde. Trabalho sem commit se perde se a sessão cair. Os commits intermediários podem ser organizados antes da entrega, porque a branch da task é local.

## Restrições invioláveis (enunciado §5 + plano)

- Dinheiro **nunca** em `number`/`float`. `Money` usa `bigint` em centavos e `numeric(20,2)` no banco. O lint bloqueia `parseFloat`, `Number(` e `toFixed`.
- Idempotência só persistente, com constraints `UNIQUE` no banco. Nada de cache em memória como garantia.
- Nunca publicar evento antes do commit. Usar o transactional outbox.
- Ledger imutável: triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE`.
- Lock por wallet (`SELECT … FOR UPDATE`) com ordem fixa wallet → transação. Nunca lock global.
- A solução tem que estar correta com **≥3 instâncias**.
- Unicidade, imutabilidade e não negatividade garantidas **no schema**.
- Testes de integração contra PostgreSQL e SQS **reais**. Nunca mockar PG nem SQS nessas suítes.

## Arquitetura

- `src/business/` é regra pura e **não importa nada externo** nem `infrastructure/`.
- `@nestjs/*` só em `src/infrastructure/framework/nest/**` e em `src/main.ts`.
- ORM, AWS SDK, `jose`, `pino`, `prom-client` e `@opentelemetry/*` só em `src/infrastructure/**`.
- Um contexto só importa outro via `entity`, `event`, `port` ou `value-object`, nunca via `use-case`.
- Ports são interfaces com prefixo `I`, em arquivo `*.port.ts`. Use cases implementam `IUseCase<Input, Output>`.
- Entidades e VOs têm construtor privado e factories `create`/`rehydrate`. `rehydrate` não revalida transições.
- Named exports. Código, nomes e commits em inglês.
- Métricas, logs e tracing ficam em decorators na infraestrutura, nunca no business.

## Qualidade (Definition of Done)

- Verdes: `bun run lint`, `bun run typecheck`, `bun run test:arch`, `bun test` e as suítes de integração/concorrência da task.
- `assertWalletConsistency` no `afterEach` de toda suíte que toca wallet.
- Sem comentários óbvios. O código segue o estilo do código ao redor.

## Documentação

- `README.md` e `ARCHITECTURE.md` em **PT-BR**, escritos com a skill `escrever-como-carllos`.
