import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from "@aws-sdk/client-sqs";

/**
 * The development replay dead-letter queue, from the command line.
 *
 *   npm run replay:list      what failed, newest captures first
 *   npm run replay:redrive   move every failed capture back to the replay queue
 *
 * A capture lands in the dead-letter queue after its handler failed on every
 * delivery. Fix the handler, keep the local API dev server running, and
 * redrive: the captures replay through the fixed code exactly as the first
 * time. Reads the replay queue from the root .env that export writes, and the
 * AWS profile the containers use (LOCAL_AWS_PROFILE), unless --profile says
 * otherwise.
 */

const root = resolve(__dirname, "..");

function readRootEnvironment(): Record<string, string | undefined> {
  const file = resolve(root, ".env");
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "list" && command !== "redrive") {
    throw new Error("Usage: tsx scripts/replay.ts list|redrive [--profile <PROFILE>]");
  }

  const environment = readRootEnvironment();
  const queueUrl = environment.DEV_LAMBDA_REPLAY_QUEUE_URL;
  if (!queueUrl) {
    throw new Error(
      "DEV_LAMBDA_REPLAY_QUEUE_URL is not in the root .env. Deploy the development graph and run npm run export:cdk-outputs first.",
    );
  }
  const profile =
    argument("profile") ?? process.env.AWS_PROFILE ?? environment.LOCAL_AWS_PROFILE;
  const region =
    argument("region") ?? process.env.AWS_REGION ?? environment.LOCAL_AWS_REGION;
  const sqs = new SQSClient({
    ...(region ? { region } : {}),
    ...(profile ? { profile } : {}),
  });

  try {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["QueueArn", "RedrivePolicy"],
      }),
    );
    const queueArn = Attributes?.QueueArn;
    const deadLetterArn = Attributes?.RedrivePolicy
      ? (JSON.parse(Attributes.RedrivePolicy) as { deadLetterTargetArn?: string })
          .deadLetterTargetArn
      : undefined;
    if (!queueArn || !deadLetterArn) {
      throw new Error("The replay queue has no dead-letter queue configured.");
    }
    const [, , , , account, queueName] = deadLetterArn.split(":");
    const { QueueUrl: deadLetterUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: queueName, QueueOwnerAWSAccountId: account }),
    );

    if (command === "redrive") {
      const { TaskHandle } = await sqs.send(
        new StartMessageMoveTaskCommand({
          SourceArn: deadLetterArn,
          DestinationArn: queueArn,
        }),
      );
      console.log(
        `Moving failed captures back to the replay queue (task ${TaskHandle ?? "started"}). ` +
          "The local API dev server replays each one as it arrives.",
      );
      return;
    }

    const { Attributes: counts } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetterUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    const waiting = Number(counts?.ApproximateNumberOfMessages ?? "0");
    console.log(`${waiting} failed capture(s) in the replay dead-letter queue.`);
    if (waiting === 0) return;

    // A short peek: the messages become visible again at once, so listing
    // never delays a redrive.
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: deadLetterUrl,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 0,
      }),
    );
    for (const message of Messages ?? []) {
      try {
        const record = (JSON.parse(message.Body ?? "") as {
          Records?: { eventTime?: string; s3?: { object?: { key?: string } } }[];
        }).Records?.[0];
        console.log(`  ${record?.eventTime ?? "?"}  ${record?.s3?.object?.key ?? "(not a capture)"}`);
      } catch {
        console.log("  (a message that is not an S3 notification)");
      }
    }
    if (waiting > (Messages?.length ?? 0)) {
      console.log(`  …and ${waiting - (Messages?.length ?? 0)} more.`);
    }
    console.log("Fix the handler, then run npm run replay:redrive.");
  } finally {
    sqs.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
