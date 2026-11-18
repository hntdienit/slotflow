import { SESClient } from "@aws-sdk/client-ses";
import { SQSClient } from "@aws-sdk/client-sqs";

export interface AwsConfig {
  region: string;
  endpoint?: string; // LocalStack in dev: http://localhost:4566. Unset => real AWS.
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function awsConfig(env = process.env): AwsConfig {
  const endpoint = env.AWS_ENDPOINT_URL;
  return {
    region: env.AWS_REGION ?? "us-east-1",
    endpoint,
    // LocalStack accepts any credentials; on real AWS the default provider chain is used.
    credentials: endpoint
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
        }
      : undefined,
  };
}

export const sqsClient = (c: AwsConfig) => new SQSClient(c);
export const sesClient = (c: AwsConfig) => new SESClient(c);
