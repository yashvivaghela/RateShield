# RateShield

A serverless API rate-limiting and usage-metering service built on AWS. Enforces per-client request quotas using a token-bucket algorithm with lazy refill, backed by atomic conditional writes in DynamoDB to eliminate race conditions under concurrent load.

## Tech Stack
 
- **AWS CDK (TypeScript)** - infrastructure as code
- **AWS Lambda (Node.js 20)** - authorizer logic, compiled from TypeScript via `NodejsFunction`/esbuild
- **Amazon API Gateway (REST API)** - request routing and custom authorizer integration
- **Amazon DynamoDB** - per-client token bucket state
- **Amazon CloudWatch** - logging, metrics, billing alarm
- **k6** - concurrency and load testing

## Architecture
 
```
Client
  │
  ▼
API Gateway (REST API)
  │  global throttle: 50 burst / 20 req/sec sustained
  │
  ▼
Authorizer Lambda
  │  circuit breaker (fail-open on DynamoDB errors)
  │  picks a random shard, looks up tier config (cached per container)
  │
  ├──▶ DynamoDB: ApiKeys           (tier config: capacity, refillRate)
  ├──▶ DynamoDB: RateLimitBuckets  (sharded token state, atomic conditional writes)
  └──▶ DynamoDB: UsageAggregates   (fire-and-forget hourly usage counters)
  │
  ▼ (if allowed)
Backend endpoint
```
 
- **API Gateway** receives all incoming requests, enforces a global throttle as a backstop, and is configured with a custom Lambda authorizer on each protected route.
- **Authorizer Lambda** runs on every request: checks the circuit breaker, looks up the caller's tier (cached per warm container), picks a random shard, computes a lazy refill based on elapsed time, and attempts to consume one token via an optimistic-concurrency conditional write. Returns an IAM policy allowing or denying the request, and fires off a non-blocking usage-counter increment.
- **DynamoDB (`RateLimitBuckets`)** stores one item per API key per shard (`apiKey#shardN`, `tokensAvailable`, `capacity`, `lastRefillTimestamp`) — the source of truth for how many tokens each client currently has.
- **DynamoDB (`ApiKeys`)** stores each key's tier configuration (`tier`, `capacity`, `refillRate`), looked up once per cache window rather than on every request.
- **DynamoDB (`UsageAggregates`)** stores a request count per `(apiKey, hourBucket)`, written asynchronously and never blocking the authorization decision.
- **Backend endpoint** is only invoked if the authorizer allows the request. Currently a placeholder (`{"status": "ok"}`) that will be extended as the project grows.

## Setup and Deployment
 
### Prerequisites
 
- Node.js 18+ and npm
- AWS CLI, configured with credentials (`aws configure`)
- AWS CDK CLI (`npm install -g aws-cdk`)
- An AWS account with a billing alarm configured (recommended before deploying any AWS resources)
### Deploy
 
```bash
npm install
cdk bootstrap   # first time only, per AWS account/region
cdk deploy
```

On success, CDK outputs the API Gateway endpoint URL.

## Test Results
 
**Concurrency test** (k6, 15 simultaneous requests against a single fresh API key, capacity 10):
 
```
allowed_requests:   10
denied_requests:    5
error_requests:     0
checks_succeeded:   100% (15/15)
```
 
Exactly the configured capacity was allowed, zero over-allowance — confirming the atomic conditional writes correctly serialize concurrent access to the same bucket.
 
**Sharded bucket under load** (50 concurrent requests against `enterprise-key-1`, capacity 50 split across 5 shards):
 
```
allowed_requests:   49
denied_requests:    1
error_requests:     0
```
 
49/50 allowed — the single denial is the expected cost of random shard selection (a request landed on an already-exhausted shard while others had tokens left), not a bug. All 5 shards received traffic, confirmed via CloudWatch logs.
 
**Sustained load test** (k6, ramping to 50 concurrent users over ~100s, mixed traffic across all three tiers):
 
| | Baseline | After caching + memory optimization |
|---|---|---|
| Throughput | ~198 req/sec | ~322 req/sec (+63%) |
| Avg latency | 167ms | 103ms (-38%) |
| P99 latency | 409ms | 244ms (-40%) |
| Errors | 0 | 0 |
 
The optimization caches the `ApiKeys` tier lookup per warm Lambda container (cutting one DynamoDB round-trip per request) and raises Lambda memory from 128MB to 256MB.
 
**Usage metering** (`query_usage.py`):
 
```
pro-key-1
---------
  2026-10-22T03:00  ->  5 requests
              TOTAL  ->  5 requests
```
 
> All numbers above are from real test runs against the deployed stack, reproducible with `k6 run tests/concurrency-test.js`, `k6 run tests/load-test.js`, and `python3 query_usage.py`.
 