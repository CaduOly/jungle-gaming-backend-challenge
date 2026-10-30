import { describe, expect, it } from 'bun:test';
import { LogCapture } from '../../../../tests/support/fakes/log-capture';
import { bindLogContext, runWithLogContext } from './log-context';
import { createLogger, REDACTED } from './logger';

describe('logger', () => {
  const setup = () => {
    const capture = new LogCapture();
    return { capture, logger: createLogger({ destination: capture }) };
  };

  it('writes JSON with the level label, the service and an ISO time', () => {
    const { capture, logger } = setup();
    logger.info('hello');
    expect(capture.lines[0]).toMatchObject({ level: 'info', service: 'jungle-wagering', message: 'hello' });
    expect(String(capture.lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('adds the AsyncLocalStorage context to every line, across awaits', async () => {
    const { capture, logger } = setup();
    await runWithLogContext({ correlationId: 'corr-1', providerId: 'provider-a', unknownField: 'x' } as never, async () => {
      await Promise.resolve();
      bindLogContext({ transactionId: 'tx-1', walletId: '' });
      logger.info('inside');
    });
    logger.info('outside');

    expect(capture.find('inside')).toMatchObject({ correlationId: 'corr-1', providerId: 'provider-a', transactionId: 'tx-1' });
    expect(capture.find('inside')).not.toHaveProperty('walletId');
    expect(capture.find('inside')).not.toHaveProperty('unknownField');
    expect(capture.find('outside')).not.toHaveProperty('correlationId');
  });

  it('keeps two concurrent contexts apart', async () => {
    const { capture, logger } = setup();
    const run = (id: string, delayMs: number) =>
      runWithLogContext({ correlationId: id }, async () => {
        await Bun.sleep(delayMs);
        logger.info(id);
      });
    await Promise.all([run('a', 5), run('b', 1)]);
    expect(capture.find('a')?.correlationId).toBe('a');
    expect(capture.find('b')?.correlationId).toBe('b');
  });

  it('redacts money and payloads at the top level and nested', () => {
    const { capture, logger } = setup();
    logger.info(
      {
        amount: '10.00',
        balance: { amount: '20.00', currency: 'BRL' },
        payload: { money: { amount: '30.00' } },
        request: { body: { money: { amount: '40.00' } }, initialBalance: { amount: '50.00' } },
        status: 'PROCESSED',
      },
      'money',
    );
    const line = capture.find('money');
    expect(line).toMatchObject({ amount: REDACTED, balance: REDACTED, payload: REDACTED, status: 'PROCESSED' });
    expect(line?.request).toEqual({ body: REDACTED, initialBalance: REDACTED });
    expect(capture.raw.join('')).not.toMatch(/[1-5]0\.00/);
  });

  it('refuses an unknown LOG_LEVEL', () => {
    expect(() => createLogger({ level: 'verbose' })).toThrow('LOG_LEVEL');
  });
});
