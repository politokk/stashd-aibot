import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { appendResponseMessages, type UIMessage } from 'ai';

config({
  path: '.env.local',
});

if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set');
}

const prisma = new PrismaClient();

const BATCH_SIZE = 100; // Process 100 chats at a time
const INSERT_BATCH_SIZE = 1000; // Insert 1000 messages at a time

type NewMessageInsert = {
  id: string;
  chatId: string;
  parts: any[];
  role: string;
  attachments: any[];
  createdAt: Date;
};

type NewVoteInsert = {
  messageId: string;
  chatId: string;
  isUpvoted: boolean;
  userId: string;
  createdAt: Date;
};

interface MessageDeprecatedContentPart {
  type: string;
  content: unknown;
}

type MessageDeprecated = {
  userId: string;
  id: string;
  chatId: string;
  role: string;
  content: any;
  createdAt: Date;
};

function getMessageRank(message: MessageDeprecated): number {
  if (
    message.role === 'assistant' &&
    (message.content as MessageDeprecatedContentPart[]).some(
      (contentPart) => contentPart.type === 'tool-call',
    )
  ) {
    return 0;
  }

  if (
    message.role === 'tool' &&
    (message.content as MessageDeprecatedContentPart[]).some(
      (contentPart) => contentPart.type === 'tool-result',
    )
  ) {
    return 1;
  }

  if (message.role === 'assistant') {
    return 2;
  }

  return 3;
}

function dedupeParts<T extends { type: string; [k: string]: any }>(
  parts: T[],
): T[] {
  const seen = new Set<string>();
  return parts.filter((p) => {
    const key = `${p.type}|${JSON.stringify(p.content ?? p)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeParts<T extends { type: string; [k: string]: any }>(
  parts: T[],
): T[] {
  return parts.filter(
    (part) => !(part.type === 'reasoning' && part.reasoning === 'undefined'),
  );
}

async function migrateMessages() {
  // Get all chats
  const chats = await prisma.chat.findMany();

  let processedCount = 0;

  for (let i = 0; i < chats.length; i += BATCH_SIZE) {
    const chatBatch = chats.slice(i, i + BATCH_SIZE);
    const chatIds = chatBatch.map((chat) => chat.id);

    // Get deprecated messages (assuming they exist in a Message table without _v2 suffix)
    const allMessages = await prisma.$queryRaw<MessageDeprecated[]>`
      SELECT id, "chatId", role, content, "createdAt", "userId" 
      FROM "Message" 
      WHERE "chatId" = ANY(${chatIds})
    `;

    // Get deprecated votes (assuming they exist in a Vote table without _v2 suffix)  
    const allVotes = await prisma.$queryRaw<{ messageId: string; chatId: string; isUpvoted: boolean; userId: string; createdAt: Date }[]>`
      SELECT "messageId", "chatId", "isUpvoted", "userId", "createdAt"
      FROM "Vote"
      WHERE "chatId" = ANY(${chatIds})
    `;

    const newMessagesToInsert: NewMessageInsert[] = [];
    const newVotesToInsert: NewVoteInsert[] = [];

    for (const chat of chatBatch) {
      processedCount++;
      console.info(`Processed ${processedCount}/${chats.length} chats`);

      const messages = allMessages
        .filter((message) => message.chatId === chat.id)
        .sort((a, b) => {
          const differenceInTime =
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          if (differenceInTime !== 0) return differenceInTime;

          return getMessageRank(a) - getMessageRank(b);
        });

      const votes = allVotes.filter((v) => v.chatId === chat.id);

      const messageSection: Array<UIMessage> = [];
      const messageSections: Array<Array<UIMessage>> = [];

      for (const message of messages) {
        const { role } = message;

        if (role === 'user' && messageSection.length > 0) {
          messageSections.push([...messageSection]);
          messageSection.length = 0;
        }

        // @ts-expect-error message.content has different type
        messageSection.push(message);
      }

      if (messageSection.length > 0) {
        messageSections.push([...messageSection]);
      }

      for (const section of messageSections) {
        const [userMessage, ...assistantMessages] = section;

        const [firstAssistantMessage] = assistantMessages;

        try {
          const uiSection = appendResponseMessages({
            messages: [userMessage],
            // @ts-expect-error: message.content has different type
            responseMessages: assistantMessages,
            _internal: {
              currentDate: () => firstAssistantMessage.createdAt ?? new Date(),
            },
          });

          const projectedUISection = uiSection
            .map((message) => {
              if (message.role === 'user') {
                return {
                  id: message.id,
                  chatId: chat.id,
                  parts: [{ type: 'text', text: message.content }],
                  role: message.role,
                  createdAt: message.createdAt,
                  attachments: [],
                } as NewMessageInsert;
              } else if (message.role === 'assistant') {
                const cleanParts = sanitizeParts(
                  dedupeParts(message.parts || []),
                );

                return {
                  id: message.id,
                  chatId: chat.id,
                  parts: cleanParts,
                  role: message.role,
                  createdAt: message.createdAt,
                  attachments: [],
                } as NewMessageInsert;
              }
              return null;
            })
            .filter((msg): msg is NewMessageInsert => msg !== null);

          for (const msg of projectedUISection) {
            newMessagesToInsert.push(msg);

            if (msg.role === 'assistant') {
              const voteByMessage = votes.find((v) => v.messageId === msg.id);
              if (voteByMessage) {
                newVotesToInsert.push({
                  messageId: msg.id,
                  chatId: msg.chatId,
                  isUpvoted: voteByMessage.isUpvoted,
                  userId: voteByMessage.userId,
                  createdAt: voteByMessage.createdAt,
                });
              }
            }
          }
        } catch (error) {
          console.error(`Error processing chat ${chat.id}: ${error}`);
        }
      }
    }

    // Insert messages in batches
    for (let j = 0; j < newMessagesToInsert.length; j += INSERT_BATCH_SIZE) {
      const messageBatch = newMessagesToInsert.slice(j, j + INSERT_BATCH_SIZE);
      if (messageBatch.length > 0) {
        await prisma.message.createMany({
          data: messageBatch.map((msg) => ({
            id: msg.id,
            chatId: msg.chatId,
            parts: msg.parts as any,
            role: msg.role,
            attachments: msg.attachments as any,
            createdAt: msg.createdAt,
            content: JSON.stringify(msg.parts),
          })),
        });
      }
    }

    // Insert votes in batches
    for (let j = 0; j < newVotesToInsert.length; j += INSERT_BATCH_SIZE) {
      const voteBatch = newVotesToInsert.slice(j, j + INSERT_BATCH_SIZE);
      if (voteBatch.length > 0) {
        await prisma.vote.createMany({
          data: voteBatch.map((vote) => ({
            messageId: vote.messageId,
            chatId: vote.chatId,
            isUpvoted: vote.isUpvoted,
            userId: vote.userId,
          })),
        });
      }
    }
  }

  console.info(`Migration completed: ${processedCount} chats processed`);
  await prisma.$disconnect();
}

migrateMessages()
  .then(() => {
    console.info('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
