import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

export class RateShieldStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const rateLimitTable = new dynamodb.Table(this, 'RateLimitBuckets', {
      tableName: 'RateLimitBuckets',
      partitionKey: {
        name: 'apiKey',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const apiKeysTable = new dynamodb.Table(this, 'ApiKeys', {
  tableName: 'ApiKeys',
  partitionKey: {
    name: 'apiKey',
    type: dynamodb.AttributeType.STRING,
  },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
    const usageTable = new dynamodb.Table(this, 'UsageAggregates', {
  tableName: 'UsageAggregates',
  partitionKey: {
    name: 'apiKey',
    type: dynamodb.AttributeType.STRING,
  },
  sortKey: {
    name: 'hourBucket',
    type: dynamodb.AttributeType.STRING,
  },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
    // --- Authorizer Lambda, now using NodejsFunction ---
const authorizerFn = new NodejsFunction(this, 'AuthorizerFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  entry: 'lambda/authorizer/index.ts',
  handler: 'handler',
  memorySize: 256, 
  environment: {
    TABLE_NAME: rateLimitTable.tableName,
    API_KEYS_TABLE_NAME: apiKeysTable.tableName,
    USAGE_TABLE_NAME: usageTable.tableName,
    SIMULATE_DYNAMO_FAILURE: this.node.tryGetContext('simulateFailure') === 'true' ? 'true' : 'false',
  },
  reservedConcurrentExecutions: 100,
});

    rateLimitTable.grantReadWriteData(authorizerFn);
    apiKeysTable.grantReadData(authorizerFn);  
    usageTable.grantWriteData(authorizerFn);

    const backendFn = new lambda.Function(this, 'BackendFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: "ok" }),
        });`
      ),
    });

    const authorizer = new apigateway.RequestAuthorizer(this, 'RateLimitAuthorizer', {
      handler: authorizerFn,
      identitySources: [apigateway.IdentitySource.header('x-api-key')],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });

    const api = new apigateway.RestApi(this, 'RateShieldApi', {
  deployOptions: {
    throttlingBurstLimit: 50,
  throttlingRateLimit: 20,
  },
});

    const ping = api.root.addResource('ping');
    ping.addMethod('GET', new apigateway.LambdaIntegration(backendFn), {
      authorizer: authorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    });

  }
}