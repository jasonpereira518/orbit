"use client";
import { Component, type ReactNode } from "react";
/** A failed provider chunk must not take text chat down with it. */
export class VoiceTransportBoundary extends Component<
  { children: ReactNode; onFailure(): void; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure();
  }
  render() {
    return this.state.failed
      ? (this.props.fallback ?? null)
      : this.props.children;
  }
}
