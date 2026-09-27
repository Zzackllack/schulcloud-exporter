import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken component from taking the whole viewer down.
 *
 * React unmounts the entire tree when a render throws, so without this a single
 * bad frame from the progress stream once left a blank page. Everything here is
 * local and read-only, so a reset button is a better answer than a stack trace:
 * whatever went wrong is transient, and the user loses nothing by trying again.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Ansicht konnte nicht dargestellt werden:", error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fatal">
        <div className="fatal-card" role="alert">
          <span className="fatal-icon">
            <AlertCircle size={26} strokeWidth={1.7} />
          </span>
          <h1>Ansicht konnte nicht geladen werden</h1>
          <p>
            In der Webansicht ist ein Fehler aufgetreten. Das Archiv auf der
            Platte ist unverändert; ein Neuladen genügt meistens.
          </p>
          {error.message ? <p className="fatal-detail">{error.message}</p> : null}
          <button
            className="import-start"
            type="button"
            onClick={() => this.setState({ error: null })}
          >
            <RotateCcw size={16} />Erneut versuchen
          </button>
        </div>
      </div>
    );
  }
}
