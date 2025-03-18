import React, { useState, useEffect } from "react";
import "./App.css";
import SchematicContainer from "./components/SchematicContainer";

// Import the demo.json data
import demoNetlistData from "./data/demo.json";

function App() {
  const [debugMode, setDebugMode] = useState(false);
  const [netlistData, setNetlistData] = useState<any>(demoNetlistData);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewerType, setViewerType] = useState<"elkjs" | "reactflow">(
    "reactflow"
  );

  // Toggle debug mode
  const toggleDebugMode = () => {
    setDebugMode(!debugMode);
  };

  // Toggle between demo data and sample schematic
  const toggleDataSource = () => {
    setNetlistData(netlistData === demoNetlistData ? null : demoNetlistData);
  };

  // Toggle between viewer types
  const toggleViewerType = () => {
    setViewerType(viewerType === "elkjs" ? "reactflow" : "elkjs");
  };

  return (
    <div className="App">
      <main style={{ padding: "0" }}>
        {isLoading ? (
          <div className="loading">Loading netlist data...</div>
        ) : loadError ? (
          <div className="error-message">
            <h3>Error Loading Data</h3>
            <p>{loadError}</p>
            <button onClick={() => setLoadError(null)}>Dismiss</button>
          </div>
        ) : (
          <SchematicContainer
            netlistData={netlistData}
            showDebug={debugMode}
            viewerType={viewerType}
          />
        )}
      </main>
    </div>
  );
}

export default App;
