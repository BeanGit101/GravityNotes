import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";

let markdownLoadPromise = null;

function loadMarkdownExtension() {
    if (!markdownLoadPromise) {
        markdownLoadPromise = import("@codemirror/lang-markdown")
            .then((module) => module.markdown())
            .then((extension) => {
                if (window.chrome && window.chrome.webview) {
                    window.chrome.webview.postMessage({
                        type: "timing",
                        message: `[EditorTiming] markdown-module-loaded ${performance.now().toFixed(1)}ms`
                    });
                }
                return extension;
            })
            .catch((error) => {
                console.error("Failed to load markdown extension", error);
                return null;
            });
    }

    return markdownLoadPromise;
}

export function createEditor(hostElement, onChange) {
    const readOnlyCompartment = new Compartment();
    const markdownCompartment = new Compartment();

    const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged && typeof onChange === "function") {
            onChange(update.state.doc.toString());
        }
    });

    let view = new EditorView({
        state: EditorState.create({
            doc: "",
            extensions: [
                basicSetup,
                markdownCompartment.of([]),
                readOnlyCompartment.of(EditorView.editable.of(true)),
                updateListener
            ]
        }),
        parent: hostElement
    });

    const applyMarkdown = async () => {
        const extension = await loadMarkdownExtension();
        if (extension) {
            view.dispatch({
                effects: markdownCompartment.reconfigure(extension)
            });
            if (window.chrome && window.chrome.webview) {
                window.chrome.webview.postMessage({
                    type: "timing",
                    message: `[EditorTiming] markdown-applied ${performance.now().toFixed(1)}ms`
                });
            }
        }
    };

    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => applyMarkdown());
    } else {
        setTimeout(() => applyMarkdown(), 0);
    }

    function setText(text) {
        const length = view.state.doc.length;
        view.dispatch({ changes: { from: 0, to: length, insert: text || "" } });
    }

    function getText() {
        return view.state.doc.toString();
    }

    function getSelection() {
        const range = view.state.selection.main;
        return {
            start: range.from,
            end: range.to,
            text: view.state.doc.sliceString(range.from, range.to)
        };
    }

    function selectRange(start, end) {
        view.dispatch({ selection: { anchor: start, head: end } });
        view.dispatch({ effects: EditorView.scrollIntoView(start, { y: "center" }) });
        view.focus();
    }

    function findNext(query, matchCase) {
        const text = getText();
        const needle = matchCase ? query : query.toLowerCase();
        const hay = matchCase ? text : text.toLowerCase();
        const startIndex = view.state.selection.main.head;
        let index = hay.indexOf(needle, startIndex);
        if (index === -1 && startIndex > 0) {
            index = hay.indexOf(needle, 0);
        }
        if (index >= 0) {
            selectRange(index, index + query.length);
        }
        return index;
    }

    function findPrevious(query, matchCase) {
        const text = getText();
        const needle = matchCase ? query : query.toLowerCase();
        const hay = matchCase ? text : text.toLowerCase();
        let startIndex = view.state.selection.main.head - query.length;
        if (startIndex < 0) startIndex = hay.length - 1;
        let index = hay.lastIndexOf(needle, startIndex);
        if (index === -1 && startIndex < hay.length - 1) {
            index = hay.lastIndexOf(needle, hay.length - 1);
        }
        if (index >= 0) {
            selectRange(index, index + query.length);
        }
        return index;
    }

    function replaceNext(query, replacement, matchCase) {
        const selected = getSelection();
        const selectedText = selected.text;
        const matches = matchCase
            ? selectedText === query
            : selectedText.toLowerCase() === query.toLowerCase();

        if (matches && selectedText.length > 0) {
            view.dispatch({ changes: { from: selected.start, to: selected.end, insert: replacement } });
            const newEnd = selected.start + replacement.length;
            selectRange(newEnd, newEnd);
            return { replaced: true, index: selected.start };
        }

        const index = findNext(query, matchCase);
        if (index >= 0) {
            const range = getSelection();
            view.dispatch({ changes: { from: range.start, to: range.end, insert: replacement } });
            const newEnd = range.start + replacement.length;
            selectRange(newEnd, newEnd);
            return { replaced: true, index: index };
        }

        return { replaced: false, index: -1 };
    }

    function replaceAll(query, replacement, matchCase) {
        const text = getText();
        const needle = matchCase ? query : query.toLowerCase();
        const hay = matchCase ? text : text.toLowerCase();
        let index = 0;
        let count = 0;
        let output = "";

        while (index < hay.length) {
            const found = hay.indexOf(needle, index);
            if (found === -1) {
                output += text.slice(index);
                break;
            }
            output += text.slice(index, found) + replacement;
            index = found + query.length;
            count++;
        }

        if (count > 0) {
            setText(output);
        }

        return count;
    }

    function setReadOnly(isReadOnly) {
        view.dispatch({
            effects: readOnlyCompartment.reconfigure(EditorView.editable.of(!isReadOnly))
        });
    }

    return {
        setText,
        getText,
        getSelection,
        findNext,
        findPrevious,
        replaceNext,
        replaceAll,
        setReadOnly
    };
}
