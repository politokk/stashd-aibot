import { auth } from '@/app/(auth)/auth';
import { getDocumentById, getDocumentVersions } from '@/lib/db/queries';
import { ChatSDKError } from '@/lib/errors';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const documentId = searchParams.get('documentId');

  if (!documentId) {
    return new ChatSDKError(
      'bad_request:api',
      'Parameter documentId is missing',
    ).toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:document').toResponse();
  }

  // Get the current document
  const document = await getDocumentById({ id: documentId });
  
  if (!document) {
    return new ChatSDKError('not_found:document').toResponse();
  }

  if (document.userId !== session.user.id) {
    return new ChatSDKError('forbidden:document').toResponse();
  }

  // Get all versions
  const versions = await getDocumentVersions({ documentId });
  
  // Combine current document with versions
  // Convert versions to document format
  const versionDocuments = versions.map((version) => ({
    id: version.documentId,
    title: version.title || document.title,
    content: (version.contentRich as any)?.content || '',
    kind: document.kind,
    userId: version.userId,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  }));

  // Add the current document as the latest version
  const allVersions = [...versionDocuments, document];

  return Response.json(allVersions, { status: 200 });
} 