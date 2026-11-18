import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";

export interface QueueMessage {
  id: string;
  body: string;
  handle: string;
  /** How many times SQS has delivered this message (drives backoff and the dead-letter redrive). */
  receiveCount: number;
}

/** Thin wrapper over one SQS queue. */
export class SqsQueue {
  constructor(
    private readonly client: SQSClient,
    readonly url: string,
  ) {}

  /** delaySeconds is capped at 900 by SQS; callers must not ask for more. */
  async send(body: string, delaySeconds = 0) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.url,
        MessageBody: body,
        DelaySeconds: Math.min(900, Math.max(0, Math.ceil(delaySeconds))),
      }),
    );
  }

  async sendBatch(items: { body: string; delaySeconds?: number }[]) {
    for (let i = 0; i < items.length; i += 10) {
      const chunk = items.slice(i, i + 10);
      const out = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.url,
          Entries: chunk.map((m, j) => ({
            Id: String(j),
            MessageBody: m.body,
            DelaySeconds: Math.min(900, Math.max(0, Math.ceil(m.delaySeconds ?? 0))),
          })),
        }),
      );
      if (out.Failed?.length)
        throw new Error(`SQS batch send failed: ${out.Failed[0]!.Message ?? out.Failed[0]!.Code}`);
    }
  }

  async receive(max = 10, waitSeconds = 1): Promise<QueueMessage[]> {
    const out = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: Math.min(10, max),
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    return (out.Messages ?? []).map((m) => ({
      id: m.MessageId!,
      body: m.Body!,
      handle: m.ReceiptHandle!,
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
    }));
  }

  async delete(m: QueueMessage) {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: m.handle }),
    );
  }

  /** Makes a failed message invisible for `seconds` (exponential backoff) instead of retrying at once. */
  async delay(m: QueueMessage, seconds: number) {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.url,
        ReceiptHandle: m.handle,
        VisibilityTimeout: Math.max(0, Math.min(43_200, Math.ceil(seconds))),
      }),
    );
  }
}

export const backoffSeconds = (receiveCount: number, baseMs: number) =>
  Math.min(900, (baseMs / 1000) * 2 ** Math.max(0, receiveCount - 1));
