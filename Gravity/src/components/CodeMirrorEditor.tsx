import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";

export interface CodeMirrorEditorProps {
  initialDoc?: string;
  placeholder?: string;
  className?: string;
}

export function CodeMirrorEditor({
  initialDoc = "",
  placeholder: placeholderText = "",
  className,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        markdown(),
        keymap.of(defaultKeymap),
        placeholder(placeholderText),
        EditorView.theme({
          "&": { minHeight: "8em" },
          "&.cm-editor": { border: "1px solid #ccc", borderRadius: "4px" },
          "&.cm-editor.cm-focused": { outline: "none", borderColor: "#888" },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: container,
    });

    return () => {
      view.destroy();
    };
  }, [initialDoc, placeholderText]);

  return <div ref={containerRef} className={className} />;
}
