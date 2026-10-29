import http from 'k6/http';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

/*
 * One HTTP scenario per run, picked by SCENARIO:
 *   distributed  every wallet of the seed, a fresh transaction per iteration;
 *   hot          the first wallet only, every iteration fights for the same row lock;
 *   mix          like distributed, plus REPLAY_PERCENT replays of an earlier request (same key and payload) and
 *                CONFLICT_PERCENT conflicts (same key, another amount).
 * Both phases use constant-arrival-rate: `warmup` (WARMUP_RATE for WARMUP) and then `main` (RATE for DURATION).
 * Only the `main` phase goes into the report; every request carries an `op` tag (fresh, replay or conflict).
 */
const SCENARIO = __ENV.SCENARIO || 'distributed';
const BASE_URL = __ENV.BASE_URL || 'http://nginx';
const PROVIDER = __ENV.PROVIDER || 'provider-load';
const RATE = parseInt(__ENV.RATE || '200', 10);
const DURATION = __ENV.DURATION || '60s';
const WARMUP_RATE = parseInt(__ENV.WARMUP_RATE || '20', 10);
const WARMUP = __ENV.WARMUP || '15s';
const REPLAY_PERCENT = parseInt(__ENV.REPLAY_PERCENT || '10', 10);
const CONFLICT_PERCENT = parseInt(__ENV.CONFLICT_PERCENT || '2', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '400', 10);

const wallets = new SharedArray('wallets', () => JSON.parse(open(__ENV.WALLETS_FILE || '/data/wallets.json')));

const STATUSES = [0, 200, 202, 400, 401, 404, 409, 413, 422, 429, 500, 502, 503, 504];
const OPS = ['fresh', 'replay', 'conflict'];

/** k6 only breaks a metric down by tag in the summary when a threshold names the submetric; `max>=0` always holds. */
const submetrics = () => {
  const always = ['max>=0'];
  const thresholds = {
    'http_req_duration{scenario:main}': always,
    'http_reqs{scenario:main}': ['count>=0'],
    'dropped_iterations{scenario:main}': ['count>=0'],
    replay_mismatches: ['count>=0'],
  };
  for (const op of OPS) {
    thresholds[`http_req_duration{scenario:main,op:${op}}`] = always;
    for (const status of STATUSES) thresholds[`http_reqs{scenario:main,op:${op},status:${status}}`] = ['count>=0'];
  }
  return thresholds;
};

const seconds = (duration) => parseInt(duration, 10) * (duration.endsWith('m') ? 60 : 1);

export const options = {
  discardResponseBodies: false,
  systemTags: ['status', 'method', 'scenario', 'expected_response'],
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'avg', 'count'],
  thresholds: submetrics(),
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      rate: WARMUP_RATE,
      timeUnit: '1s',
      duration: WARMUP,
      preAllocatedVUs: Math.min(50, MAX_VUS),
      maxVUs: MAX_VUS,
    },
    main: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      startTime: `${seconds(WARMUP)}s`,
      preAllocatedVUs: Math.min(RATE, MAX_VUS),
      maxVUs: MAX_VUS,
    },
  },
};

const headers = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer dev:${PROVIDER}`,
  'Idempotency-Key': key,
});

const pickWallet = () => (SCENARIO === 'hot' ? wallets[0] : wallets[Math.floor(Math.random() * wallets.length)]);

const pickKind = () => {
  const roll = Math.random();
  if (roll < 0.6) return 'BET';
  if (roll < 0.85) return 'WIN';
  return 'LOSS';
};

const newTransaction = () => {
  const wallet = pickWallet();
  const externalTransactionId = `${SCENARIO}-${exec.scenario.name}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}-${Date.now()}`;
  return {
    key: `${PROVIDER}:${externalTransactionId}`,
    body: {
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${externalTransactionId}`,
      gameId: 'load-test',
      kind: pickKind(),
      money: { amount: '1.00', currency: 'BRL' },
    },
  };
};

const sent = [];
const replayMismatches = new Counter('replay_mismatches');

const send = (transaction, op) =>
  http.post(`${BASE_URL}/wagering/transactions`, JSON.stringify(transaction.body), {
    headers: headers(transaction.key),
    tags: { op },
    responseCallback: http.expectedStatuses(op === 'conflict' ? 409 : 200),
  });

export default function () {
  if (SCENARIO === 'mix' && sent.length > 0) {
    const roll = Math.random() * 100;
    const earlier = sent[Math.floor(Math.random() * sent.length)];
    if (roll < REPLAY_PERCENT) {
      const replay = send(earlier, 'replay');
      if (replay.status !== 200 || replay.json('data.idempotentReplay') !== true) replayMismatches.add(1);
      return;
    }
    if (roll < REPLAY_PERCENT + CONFLICT_PERCENT) {
      send({ key: earlier.key, body: { ...earlier.body, money: { amount: '2.00', currency: 'BRL' } } }, 'conflict');
      return;
    }
  }
  const transaction = newTransaction();
  const response = send(transaction, 'fresh');
  if (SCENARIO === 'mix' && response.status === 200) {
    sent.push(transaction);
    if (sent.length > 200) sent.shift();
  }
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE || '/out/summary.json']: JSON.stringify(data) };
}
