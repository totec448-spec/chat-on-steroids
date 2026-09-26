import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';

export interface ProjectCodeEditor {
  view: EditorView;
  language: string;
  getValue(): string;
  focus(): void;
  destroy(): void;
}

export interface ProjectDiffViewer {
  view: EditorView;
  language: string;
  destroy(): void;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    color: 'var(--ink)',
    backgroundColor: 'transparent',
    fontSize: 'calc(12px * var(--text-scale, 1))'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    minHeight: '0',
    fontFamily: 'var(--mono)',
    lineHeight: '1.55',
    overflow: 'auto'
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '10px 0',
    caretColor: 'var(--ink)'
  },
  '.cm-line': { padding: '0 12px 0 8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--sunk)',
    color: 'var(--faint)',
    border: '0',
    borderRight: '1px solid var(--line)'
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '30px' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--soft)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 62%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-wash)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--hover)',
    border: '1px solid var(--line)',
    color: 'var(--soft)'
  },
  '.cm-tooltip': {
    border: '1px solid var(--edge)',
    backgroundColor: 'var(--card)',
    color: 'var(--ink)'
  },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--ink)' },
  '.cm-searchMatch': { backgroundColor: 'var(--syntax-search)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--syntax-search-selected)' },
  '.cm-changedLine, .cm-inlineChangedLine': { backgroundColor: 'var(--green-wash)' },
  '.cm-changedText': { backgroundColor: 'color-mix(in srgb, var(--green) 24%, transparent)' },
  '.cm-deletedChunk': { backgroundColor: 'var(--red-wash)', color: 'var(--ink)' },
  '.cm-deletedText': { backgroundColor: 'color-mix(in srgb, var(--red) 24%, transparent)' },
  '.cm-changedLineGutter': { backgroundColor: 'var(--green)' },
  '.cm-deletedLineGutter': { backgroundColor: 'var(--red)' },
  '.cm-collapsedLines': { backgroundColor: 'var(--card)', color: 'var(--soft)', borderColor: 'var(--line)' }
});

const syntaxTheme = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.character, tags.docString, tags.attributeValue], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], color: 'var(--syntax-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--syntax-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syntax-property)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--syntax-regexp)' },
  { tag: [tags.operator, tags.derefOperator, tags.arithmeticOperator, tags.logicOperator, tags.compareOperator], color: 'var(--syntax-operator)' },
  { tag: [tags.labelName, tags.macroName], color: 'var(--syntax-label)' },
  { tag: tags.invalid, color: 'var(--red)', textDecoration: 'underline wavy' }
]);

/**
 * Creates the shared code surface used by both the read-only preview and edit mode. Language
 * packages are loaded lazily from CodeMirror's catalogue so Files does not pay parser cost at
 * startup, while a clicked source file can still get highlighting as soon as its preview opens.
 */
export async function createProjectCodeEditor(options: {
  parent: HTMLElement;
  filename: string;
  text: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}): Promise<ProjectCodeEditor> {
  const description = LanguageDescription.matchFilename(languages, options.filename);
  let support = null;
  if (description) {
    try { support = await description.load(); }
    catch { /* An unavailable parser falls back to plain text without blocking editing. */ }
  }

  const view = new EditorView({
    doc: options.text,
    parent: options.parent,
    extensions: [
      basicSetup,
      editorTheme,
      syntaxHighlighting(syntaxTheme),
      EditorView.lineWrapping,
      EditorState.lineSeparator.of(options.text.includes('\r\n') ? '\r\n' : '\n'),
      EditorState.changeFilter.of(transaction => transaction.newDoc.length <= 256 * 1024),
      ...(support ? [support] : []),
      ...(options.readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
      EditorView.updateListener.of(update => {
        if (update.docChanged) options.onChange?.(update.state.sliceDoc());
      })
    ]
  });

  return {
    view,
    language: description?.name ?? 'Plain text',
    getValue: () => view.state.sliceDoc(),
    focus: () => view.focus(),
    destroy: () => view.destroy()
  };
}

/** Read-only unified diff for either current Git state or one recorded edit. */
export async function createProjectDiffViewer(options: {
  parent: HTMLElement;
  filename: string;
  baseText: string;
  currentText: string;
}): Promise<ProjectDiffViewer> {
  const { getChunks, unifiedMergeView } = await import('@codemirror/merge');
  const description = LanguageDescription.matchFilename(languages, options.filename);
  let support = null;
  if (description) {
    try { support = await description.load(); }
    catch { /* Plain text remains a complete, readable fallback. */ }
  }
  const view = new EditorView({
    doc: options.currentText,
    parent: options.parent,
    extensions: [
      basicSetup,
      editorTheme,
      syntaxHighlighting(syntaxTheme),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      ...(support ? [support] : []),
      unifiedMergeView({
        original: options.baseText,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        allowInlineDiffs: true,
        mergeControls: false,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 6 }
      })
    ]
  });
  const firstChange = getChunks(view.state)?.chunks[0];
  if (firstChange) {
    view.dispatch({ effects: EditorView.scrollIntoView(
      Math.min(firstChange.fromB, view.state.doc.length), { y: 'center' }
    ) });
  }
  return { view, language: description?.name ?? 'Plain text', destroy: () => view.destroy() };
}
