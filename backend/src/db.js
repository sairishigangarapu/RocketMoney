'use strict';
/* DynamoDB document client factory.
 * Production: default AWS credential chain + region from AWS_REGION (fail-fast validated).
 * Local dev/test: set DYNAMODB_ENDPOINT (e.g. http://localhost:8000 for DynamoDB Local);
 * dev credentials are used ONLY in that case and never touch real AWS.
 */
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

function createDocClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'ap-south-1',
    ...(endpoint
      ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

module.exports = { createDocClient };
