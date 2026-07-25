"use client";
import React from "react";

// A page throw shouldn't blank the whole panel (no gate, no nav). This catches it and shows the
// message in place, so a broken page is diagnosable instead of a black screen.
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-danger/50 bg-danger/10 p-5 text-body">
          <div className="mb-2 font-semibold text-danger">This page hit an error</div>
          <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-ui text-muted-foreground">
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
