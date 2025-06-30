import OrderedMap from 'orderedmap';
import {
  Schema,
  type Node as ProsemirrorNode,
  type MarkSpec,
  DOMParser,
} from 'prosemirror-model';
import { schema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import React, { useEffect, useRef, useState } from 'react';
import { renderToString } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { Plus, Minus, FileText } from 'lucide-react';

import { diffEditor, DiffType } from '@/lib/editor/diff';

const diffSchema = new Schema({
  nodes: addListNodes(schema.spec.nodes, 'paragraph block*', 'block'),
  marks: OrderedMap.from({
    ...schema.spec.marks.toObject(),
    diffMark: {
      attrs: { type: { default: '' } },
      toDOM(mark) {
        const type = mark.attrs.type;
        
        if (type === DiffType.Inserted) {
          return ['span', { 
            class: 'diff-inserted',
            'data-diff': 'inserted'
          }, 0];
        } else if (type === DiffType.Deleted) {
          return ['span', { 
            class: 'diff-deleted',
            'data-diff': 'deleted'
          }, 0];
        }
        
        return ['span', {}, 0];
      },
    } as MarkSpec,
  }),
});

function computeDiff(oldDoc: ProsemirrorNode, newDoc: ProsemirrorNode) {
  return diffEditor(diffSchema, oldDoc.toJSON(), newDoc.toJSON());
}

function countChanges(element: HTMLElement) {
  const insertions = element.querySelectorAll('.diff-inserted').length;
  const deletions = element.querySelectorAll('.diff-deleted').length;
  return { insertions, deletions };
}

type DiffEditorProps = {
  oldContent: string;
  newContent: string;
};

export const DiffView = ({ oldContent, newContent }: DiffEditorProps) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [stats, setStats] = useState({ insertions: 0, deletions: 0 });

  useEffect(() => {
    if (editorRef.current && !viewRef.current) {
      const parser = DOMParser.fromSchema(diffSchema);

      const oldHtmlContent = renderToString(
        <ReactMarkdown>{oldContent}</ReactMarkdown>,
      );
      const newHtmlContent = renderToString(
        <ReactMarkdown>{newContent}</ReactMarkdown>,
      );

      const oldContainer = document.createElement('div');
      oldContainer.innerHTML = oldHtmlContent;

      const newContainer = document.createElement('div');
      newContainer.innerHTML = newHtmlContent;

      const oldDoc = parser.parse(oldContainer);
      const newDoc = parser.parse(newContainer);

      const diffedDoc = computeDiff(oldDoc, newDoc);

      const state = EditorState.create({
        doc: diffedDoc,
        plugins: [],
      });

      viewRef.current = new EditorView(editorRef.current, {
        state,
        editable: () => false,
      });

      // Count changes after rendering
      setTimeout(() => {
        if (editorRef.current) {
          const counts = countChanges(editorRef.current);
          setStats(counts);
        }
      }, 100);
    }

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [oldContent, newContent]);

  return (
    <div className="relative h-full flex flex-col bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <h3 className="font-medium">Document Changes</h3>
            </div>
            <div className="flex gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-green-500/10">
                  <Plus className="h-3 w-3 text-green-600 dark:text-green-400" />
                  <span className="font-medium text-green-700 dark:text-green-300">
                    {stats.insertions}
                  </span>
                </div>
                <span className="text-muted-foreground">additions</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-500/10">
                  <Minus className="h-3 w-3 text-red-600 dark:text-red-400" />
                  <span className="font-medium text-red-700 dark:text-red-300">
                    {stats.deletions}
                  </span>
                </div>
                <span className="text-muted-foreground">deletions</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto">
          <div className="diff-editor px-8 py-8 prose prose-sm dark:prose-invert max-w-none" ref={editorRef} />
        </div>
      </div>

      {/* Footer with legend */}
      <div className="border-t bg-muted/30 px-6 py-3">
        <div className="flex gap-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-sm bg-green-500/80 ring-1 ring-green-500/20"></span>
            Text added in this version
          </span>
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-sm bg-red-500/80 ring-1 ring-red-500/20"></span>
            Text removed from previous version
          </span>
        </div>
      </div>
    </div>
  );
};
