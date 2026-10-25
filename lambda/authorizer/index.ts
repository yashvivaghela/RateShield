import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME!;
const API_KEYS_TABLE_NAME = process.env.API_KEYS_TABLE_NAME!;
const COST = 1;
const MAX_RETRIES = 5;
const NUM_SHARDS = 5;


// --- Circuit breaker config ---
const ERROR_THRESHOLD = 3;        // errors within the window that trip the breaker
const ERROR_WINDOW_MS = 10_000;   // 10 seconds
const OPEN_DURATION_MS = 15_000;  // how long to stay open before trying half-open

// --- Circuit breaker state (module-level = persists across warm invocations
// of THIS container only; see design-decisions notes for why) ---
type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
let breakerState: BreakerState = 'CLOSED';
let recentErrorTimestamps: number[] = [];
let openedAt: number | null = null;
// --- Per-container cache for ApiKeys lookups (reduces DynamoDB round-trips) ---
const KEY_CONFIG_CACHE_TTL_MS = 60_000; // 60 seconds
const keyConfigCache = new Map<string, { capacity: number; refillRate: number; cachedAt: number }>();

// --- TEST-ONLY: time-bounded failure simulation ---
const CONTAINER_START = Date.now(); // set once, when this container cold-starts
const SIMULATE_FAILURE_DURATION_MS = 12_000; // fail for the first 12s of this container's life, then recover

function recordFailure() {
  const now = Date.now();
  recentErrorTimestamps.push(now);
  // Drop errors outside the rolling window
  recentErrorTimestamps = recentErrorTimestamps.filter(t => now - t <= ERROR_WINDOW_MS);

  if (breakerState === 'HALF_OPEN') {
    // The test request failed — reopen, reset the cooldown
    breakerState = 'OPEN';
    openedAt = now;
    console.warn('Circuit breaker: half-open test failed, reopening');
  } else if (breakerState === 'CLOSED' && recentErrorTimestamps.length >= ERROR_THRESHOLD) {
    breakerState = 'OPEN';
    openedAt = now;
    console.warn(`Circuit breaker: OPENED after ${recentErrorTimestamps.length} errors in window`);
  }
}

function recordSuccess() {
  if (breakerState === 'HALF_OPEN') {
    // The test request succeeded — close the breaker, resume normal operation
    breakerState = 'CLOSED';
    recentErrorTimestamps = [];
    openedAt = null;
    console.warn('Circuit breaker: CLOSED after successful half-open test');
  }
}

// Returns true if we should skip DynamoDB and fail open (allow unenforced)
function shouldFailOpen(): boolean {
  const now = Date.now();

  if (breakerState === 'OPEN') {
    if (openedAt !== null && now - openedAt >= OPEN_DURATION_MS) {
      // Cooldown expired — move to half-open, allow ONE real attempt through
      breakerState = 'HALF_OPEN';
      console.warn('Circuit breaker: moving to HALF_OPEN, allowing test request');
      return false; // let this one request actually hit DynamoDB
    }
    return true; // still open, skip DynamoDB
  }

  return false; // closed or half-open (half-open lets the test request through)
}

function buildPolicy(principalId: string, effect: 'Allow' | 'Deny', resource: string) {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
    },
  };
}
const USAGE_TABLE_NAME = process.env.USAGE_TABLE_NAME!;

function getHourBucket(date: Date): string {
  return date.toISOString().slice(0, 13); // e.g. "2026-10-19T07"
}

async function recordUsage(apiKey: string, now: Date): Promise<void> {
  const hourBucket = getHourBucket(now);
  await docClient.send(new UpdateCommand({
    TableName: USAGE_TABLE_NAME,
    Key: { apiKey, hourBucket },
    UpdateExpression: 'ADD requestCount :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
}

async function getKeyConfig(apiKey: string): Promise<{ capacity: number; refillRate: number } | null> {
   const cached = keyConfigCache.get(apiKey);
  const now = Date.now();

  if (cached && now - cached.cachedAt < KEY_CONFIG_CACHE_TTL_MS) {
    return { capacity: cached.capacity, refillRate: cached.refillRate };
  }
  const result = await docClient.send(new GetCommand({
    TableName: API_KEYS_TABLE_NAME,
    Key: { apiKey },
  }));

  if (!result.Item) {
    return null;
  }

  return {
    capacity: result.Item.capacity,
    refillRate: result.Item.refillRate,
  };
}


async function tryConsumeToken(
  shardKey: string,
  now: number,
  shardCapacity: number,
  shardRefillRate: number
): Promise<boolean> {
   // --- TEST-ONLY: forced failure injection for circuit breaker testing ---
    if (
    process.env.SIMULATE_DYNAMO_FAILURE === 'true' &&
    Date.now() - CONTAINER_START < SIMULATE_FAILURE_DURATION_MS
  ) {
    throw new Error('Simulated DynamoDB failure (test mode)');
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const getResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { apiKey: shardKey },
      ConsistentRead: true,
    }));

    const item = getResult.Item;
    const prevTokens = item?.tokensAvailable ?? shardCapacity;
    const prevTimestamp = item?.lastRefillTimestamp ?? now;

    const elapsed = Math.max(0, now - prevTimestamp);
    const refilled = Math.min(shardCapacity, prevTokens + elapsed * shardRefillRate);

    if (refilled < COST) {
      return false;
    }

    const newTokens = refilled - COST;

    try {
      if (item) {
        await docClient.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { apiKey: shardKey },
          UpdateExpression: 'SET tokensAvailable = :newTokens, lastRefillTimestamp = :now',
          ConditionExpression: 'tokensAvailable = :prevTokens AND lastRefillTimestamp = :prevTimestamp',
          ExpressionAttributeValues: {
            ':newTokens': newTokens,
            ':now': now,
            ':prevTokens': prevTokens,
            ':prevTimestamp': prevTimestamp,
          },
        }));
      } else {
        await docClient.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { apiKey: shardKey },
          UpdateExpression: 'SET tokensAvailable = :newTokens, lastRefillTimestamp = :now, #cap = :capacity',
          ConditionExpression: 'attribute_not_exists(apiKey)',
          ExpressionAttributeNames: { '#cap': 'capacity' },
          ExpressionAttributeValues: {
            ':newTokens': newTokens,
            ':now': now,
            ':capacity': shardCapacity,
          },
        }));
      }
      return true;
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') {
        continue;
      }
      throw err;
    }
  }

  return false;
}

export const handler = async (event: any) => {
  console.log('DEBUG env check v2:', process.env.SIMULATE_DYNAMO_FAILURE);
  const apiKey = event.headers?.['x-api-key'];
  const methodArn = event.methodArn;

  if (!apiKey) {
    return buildPolicy('anonymous', 'Deny', methodArn);
  }

  // --- Circuit breaker check: if open, skip DynamoDB entirely ---
  if (shouldFailOpen()) {
    console.warn(`Circuit breaker OPEN — allowing request for ${apiKey} unenforced`);
    return buildPolicy(apiKey, 'Allow', methodArn);
  }

  try {
    const config = await getKeyConfig(apiKey);
    if (!config) {
      
      recordSuccess(); // DynamoDB itself worked fine; this is a legitimate "key not found"
      return buildPolicy(apiKey, 'Deny', methodArn);
    }

    
    const shardIndex = Math.floor(Math.random() * NUM_SHARDS);
    const shardKey = `${apiKey}#shard${shardIndex}`;
    const shardCapacity = config.capacity / NUM_SHARDS;
    const shardRefillRate = config.refillRate / NUM_SHARDS;

    const now = Math.floor(Date.now() / 1000);
const allowed = await tryConsumeToken(shardKey, now, shardCapacity, shardRefillRate);

recordUsage(apiKey, new Date()).catch(err => {
  console.error('Usage metering failed (non-critical):', err.message);
});

recordSuccess();
return buildPolicy(apiKey, allowed ? 'Allow' : 'Deny', methodArn)

  } catch (err: any) {
    // Genuine infrastructure error (not a conditional check failure, which
    // is already handled inside tryConsumeToken's own try/catch and never
    // reaches here as a thrown error)
    recordFailure();
    console.error('DynamoDB error, failing open:', err.name, err.message);
    return buildPolicy(apiKey, 'Allow', methodArn); // fail open on this request too
  }
};