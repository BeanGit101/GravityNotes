import { Component, type ReactNode } from "react";
import { markStartupError } from "../state/startupDiagnostics";

interface NoteListErrorBoundaryProps {
  children: ReactNode;
}

interface NoteListErrorBoundaryState {
  errorMessage: string | null;
}

export class NoteListErrorBoundary extends Component<
  NoteListErrorBoundaryProps,
  NoteListErrorBoundaryState
> {
  override state: NoteListErrorBoundaryState = {
    errorMessage: null,
  };

  static getDerivedStateFromError(error: Error): NoteListErrorBoundaryState {
    return {
      errorMessage: error.message || "Unknown NoteList error",
    };
  }

  override componentDidCatch(error: Error): void {
    markStartupError("notelist.render.failed", {
      message: error.message,
    });
    console.error("NoteList render failed", error);
  }

  override render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <div className="note-list note-list--error-boundary" role="alert">
          <div className="note-list__header">
            <div>
              <p className="note-list__eyebrow">Vault</p>
              <h2 className="note-list__title">Sidebar failed to render</h2>
              <p className="note-list__path">The note list crashed during startup.</p>
            </div>
          </div>
          <p className="note-list__error">{this.state.errorMessage}</p>
        </div>
      );
    }

    return this.props.children;
  }
}
