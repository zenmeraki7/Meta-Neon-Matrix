import React from "react";

class CellErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error("Cell boundary error:", error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || "[render error]";
    }
    return this.props.children;
  }
}

export default CellErrorBoundary;

