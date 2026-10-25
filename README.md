# RateShield

A serverless API rate-limiting and usage-metering service built on AWS. Enforces per-client request quotas using a token-bucket algorithm with lazy refill, backed by atomic conditional writes in DynamoDB to eliminate race conditions under concurrent load.

## Tech Stack
 
- **AWS CDK (TypeScript)** - infrastructure as code
- **AWS Lambda (Node.js 20)** - authorizer logic, compiled from TypeScript via `NodejsFunction`/esbuild
- **Amazon API Gateway (REST API)** - request routing and custom authorizer integration
- **Amazon DynamoDB** - per-client token bucket state
- **Amazon CloudWatch** - logging, metrics, billing alarm
- **k6** - concurrency and load testing