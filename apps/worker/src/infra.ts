import { VerifyEmailIdentityCommand } from "@aws-sdk/client-ses";
import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { SESClient } from "@aws-sdk/client-ses";
import { SqsQueue } from "./queue";

export interface Queues {
  events: SqsQueue;
  eventsDlq: SqsQueue;
  notifications: SqsQueue;
  notificationsDlq: SqsQueue;
}

export interface InfraOptions {
  prefix?: string;
  maxReceiveCount: number;
  visibilitySeconds?: number;
  sender?: string;
}

/**
 * Creates (idempotently) the queues, their dead-letter queues with a redrive policy, and verifies the
 * sender identity. Safe to run on every start; on real AWS the same resources would come from IaC.
 */
export async function ensureInfrastructure(
  sqs: SQSClient,
  ses: SESClient,
  o: InfraOptions,
): Promise<Queues> {
  const p = o.prefix ?? "slotflow-";
  const make = async (name: string, attributes: Record<string, string> = {}) => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );
    return QueueUrl!;
  };
  const arn = async (url: string) =>
    (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] })))
      .Attributes!.QueueArn!;

  const eventsDlq = await make(`${p}events-dlq`);
  const notificationsDlq = await make(`${p}notifications-dlq`);
  const attrs = async (dlq: string) => ({
    VisibilityTimeout: String(o.visibilitySeconds ?? 60),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: await arn(dlq),
      maxReceiveCount: o.maxReceiveCount,
    }),
  });
  const events = await make(`${p}events`, await attrs(eventsDlq));
  const notifications = await make(`${p}notifications`, await attrs(notificationsDlq));
  if (o.sender) await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: o.sender }));
  return {
    events: new SqsQueue(sqs, events),
    eventsDlq: new SqsQueue(sqs, eventsDlq),
    notifications: new SqsQueue(sqs, notifications),
    notificationsDlq: new SqsQueue(sqs, notificationsDlq),
  };
}
