import 'server-only';

import { PrismaClient } from '@prisma/client';
import type { User, Chat, Message, Vote, Document, Suggestion, Stream } from '@prisma/client';

import { generateUUID } from '../utils';
import { generateHashedPassword } from './utils';
import { ChatSDKError } from '../errors';

// Type aliases for backward compatibility
export type VisibilityType = 'private' | 'public';
export type ArtifactKind = 'text' | 'code' | 'image' | 'sheet';

// Initialize Prisma Client
const prisma = new PrismaClient();

// Export types for backward compatibility
export type { User, Chat, Document, Suggestion, Stream, Vote };
export type DBMessage = Message;

export async function getUser(email: string): Promise<Array<User>> {
  try {
    return await prisma.user.findMany({ where: { email } });
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get user by email',
    );
  }
}

export async function createUser(email: string, password: string) {
  const hashedPassword = generateHashedPassword(password);
  const userId = generateUUID();
  const username = email.split('@')[0] + '_' + Date.now(); // Generate username from email

  try {
    return await prisma.user.create({ 
      data: { 
        id: userId,
        username,
        email, 
        password_hash: hashedPassword // Note: field name is password_hash, not password
      } 
    });
  } catch (error) {
    throw new ChatSDKError('bad_request:database', 'Failed to create user');
  }
}

export async function createGuestUser() {
  const userId = generateUUID();
  const email = `guest-${Date.now()}@example.com`;
  const username = `guest_${Date.now()}`;
  const hashedPassword = generateHashedPassword(generateUUID());

  try {
    const guestUser = await prisma.user.create({
      data: { 
        id: userId,
        username,
        email, 
        password_hash: hashedPassword // Note: field name is password_hash, not password
      },
      select: { id: true, email: true, username: true },
    });
    return [guestUser];
  } catch (error) {
    console.error('Error creating guest user:', error);
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to create guest user',
    );
  }
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  try {
    return await prisma.chat.create({
      data: {
        id,
        createdAt: new Date(),
        userId,
        title,
        visibility,
      },
    });
  } catch (error) {
    throw new ChatSDKError('bad_request:database', 'Failed to save chat');
  }
}

export async function deleteChatById({ id }: { id: string }) {
  try {
    await prisma.vote.deleteMany({ where: { chatId: id } });
    await prisma.message.deleteMany({ where: { chatId: id } });
    await prisma.stream.deleteMany({ where: { chatId: id } });

    const chatsDeleted = await prisma.chat.delete({
      where: { id },
    });
    return chatsDeleted;
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to delete chat by id',
    );
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: any) =>
      prisma.chat.findMany({
        where: {
          userId: id,
          ...whereCondition,
        },
        orderBy: { createdAt: 'desc' },
        take: extendedLimit,
      });

    let filteredChats: Array<Chat> = [];

    if (startingAfter) {
      const selectedChat = await prisma.chat.findFirst({
        where: { id: startingAfter },
      });

      if (!selectedChat) {
        throw new ChatSDKError(
          'not_found:database',
          `Chat with id ${startingAfter} not found`,
        );
      }

      filteredChats = await query({ createdAt: { gt: selectedChat.createdAt } });
    } else if (endingBefore) {
      const selectedChat = await prisma.chat.findFirst({
        where: { id: endingBefore },
      });

      if (!selectedChat) {
        throw new ChatSDKError(
          'not_found:database',
          `Chat with id ${endingBefore} not found`,
        );
      }

      filteredChats = await query({ createdAt: { lt: selectedChat.createdAt } });
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get chats by user id',
    );
  }
}

export async function getChatById({ id }: { id: string }) {
  try {
    const selectedChat = await prisma.chat.findFirst({ where: { id } });
    return selectedChat;
  } catch (error) {
    throw new ChatSDKError('bad_request:database', 'Failed to get chat by id');
  }
}

export async function saveMessages({
  messages,
}: {
  messages: Array<DBMessage>;
}) {
  try {
    return await prisma.message.createMany({ 
      data: messages as any // Type casting needed for JSON fields
    });
  } catch (error) {
    throw new ChatSDKError('bad_request:database', 'Failed to save messages');
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  try {
    return await prisma.message.findMany({
      where: { chatId: id },
      orderBy: { createdAt: 'asc' },
    });
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get messages by chat id',
    );
  }
}

export async function voteMessage({
  chatId,
  messageId,
  userId,
  type,
}: {
  chatId: string;
  messageId: string;
  userId: string;
  type: 'up' | 'down';
}) {
  try {
    const existingVote = await prisma.vote.findFirst({
      where: { 
        chatId,
        messageId,
        userId
      },
    });

    if (existingVote) {
      return await prisma.vote.update({
        where: { 
          chatId_messageId_userId: {
            chatId,
            messageId,
            userId
          }
        },
        data: { isUpvoted: type === 'up' },
      });
    }
    return await prisma.vote.create({
      data: {
        chatId,
        messageId,
        userId,
        isUpvoted: type === 'up',
      },
    });
  } catch (error) {
    throw new ChatSDKError('bad_request:database', 'Failed to vote message');
  }
}

export async function getVotesByChatId({ id }: { id: string }) {
  try {
    return await prisma.vote.findMany({ where: { chatId: id } });
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get votes by chat id',
    );
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  try {
    const document = await prisma.document.create({
      data: {
        id,
        title,
        kind,
        content,
        userId,
        createdAt: new Date(),
      },
    });
    return [document];
  } catch (error) {
    throw new ChatSDKError('bad_request:database', 'Failed to save document');
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  try {
    const documents = await prisma.document.findMany({
      where: { id },
      orderBy: { createdAt: 'asc' },
    });

    return documents;
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get documents by id',
    );
  }
}

export async function getDocumentById({ id }: { id: string }) {
  try {
    const selectedDocument = await prisma.document.findFirst({
      where: { id },
      orderBy: { createdAt: 'desc' },
    });

    return selectedDocument;
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get document by id',
    );
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  try {
    await prisma.suggestion.deleteMany({
      where: {
        documentId: id,
        createdAt: { gt: timestamp },
      },
    });

    const deletedDocs = await prisma.document.findMany({
      where: {
        id,
        createdAt: { gt: timestamp },
      },
    });

    await prisma.document.deleteMany({
      where: {
        id,
        createdAt: { gt: timestamp },
      },
    });

    return deletedDocs;
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to delete documents by id after timestamp',
    );
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Array<Suggestion>;
}) {
  try {
    return await prisma.suggestion.createMany({ data: suggestions });
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to save suggestions',
    );
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  try {
    return await prisma.suggestion.findMany({
      where: { documentId },
    });
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get suggestions by document id',
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  try {
    return await prisma.message.findFirst({ where: { id } });
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get message by id',
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  try {
    const messagesToDelete = await prisma.message.findMany({
      where: {
        chatId,
        createdAt: { gte: timestamp },
      },
    });

    const messageIds = messagesToDelete.map((message) => message.id);

    if (messageIds.length > 0) {
      await prisma.vote.deleteMany({
        where: {
          chatId,
          messageId: { in: messageIds },
        },
      });

      return await prisma.message.deleteMany({
        where: {
          chatId,
          id: { in: messageIds },
        },
      });
    }
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to delete messages by chat id after timestamp',
    );
  }
}

export async function updateChatVisiblityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: 'private' | 'public';
}) {
  try {
    return await prisma.chat.update({
      where: { id: chatId },
      data: { visibility },
    });
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to update chat visibility by id',
    );
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: { id: string; differenceInHours: number }) {
  try {
    const twentyFourHoursAgo = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000,
    );

    const stats = await prisma.message.count({
      where: {
        chat: { userId: id },
        createdAt: { gte: twentyFourHoursAgo },
        role: 'user',
      },
    });

    return stats;
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get message count by user id',
    );
  }
}

export async function createStreamId({
  streamId,
  chatId,
}: {
  streamId: string;
  chatId: string;
}) {
  try {
    await prisma.stream.create({
      data: { id: streamId, chatId, createdAt: new Date() },
    });
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to create stream id',
    );
  }
}

export async function getStreamIdsByChatId({ chatId }: { chatId: string }) {
  try {
    const streamIds = await prisma.stream.findMany({
      where: { chatId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    return streamIds.map(({ id }) => id);
  } catch (error) {
    throw new ChatSDKError(
      'bad_request:database',
      'Failed to get stream ids by chat id',
    );
  }
}