# Infra de teste

Todas as suítes de integração, concorrência e carga rodam contra o mesmo stack do compose
(`name: jungle-wagering`). O isolamento vem dos helpers em `tests/support/`.

## Isolamento

- `createTestDatabase()` cria `wagering_test_<uuidv7>` e devolve `drop()`.
- `createTestQueues()` cria `wager-transactions[-dlq]-<uuidv7>.fifo` e `wagering-events[-dlq]-<uuidv7>.fifo` com redrive e devolve `destroy()`.
  Se uma das filas falhar no meio, as que já nasceram são apagadas.
- `ResourceScope.track()` registra o cleanup no momento em que a criação começa. Um `dispose()` no
  `afterEach` derruba tudo, inclusive recurso que terminou de nascer depois de o teste falhar.
- `ensureInfraUp()` falha com mensagem clara quando o stack não está de pé.

## Sweep de recursos vazados

Se um processo de teste morrer antes do cleanup, sobram bancos e filas. Para limpar:

```bash
bun run test:sweep                          # recursos com mais de 30 minutos
bun run test:sweep --older-than-minutes=180
bun run test:sweep --all                    # tudo, sem olhar a idade
bun run test:sweep --help
```

A idade sai do timestamp do UUIDv7 no sufixo. As 4 filas do compose nunca entram no sweep.

**Cuidado:** o stack é compartilhado. O sweep não sabe se uma execução ainda está viva, só olha a idade.
Com o padrão de 30 minutos, ele derruba o banco e as filas de uma execução longa que ainda esteja
rodando, como a carga (`bun run test:load`) ou um `--rerun-each` grande. Enquanto uma execução dessas
estiver de pé, passe um `--older-than-minutes` maior que a duração dela. Nunca use `--all` com outra
pessoa testando.
