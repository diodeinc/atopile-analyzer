import React, { useState, useEffect } from "react";
import "./App.css";
import SchematicContainer from "./components/SchematicContainer";
import demoData from "./data/demo.json";
import { Netlist } from "./types/NetlistTypes";

// Get VSCode API
declare const acquireVsCodeApi: () => {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};

// Helper to detect if we're in VSCode
const isVSCodeEnvironment = () => {
  try {
    return !!acquireVsCodeApi;
  } catch {
    return false;
  }
};

// Initialize VSCode API only in production
const vscode = isVSCodeEnvironment() ? acquireVsCodeApi() : null;

function App() {
  const [netlistData, setNetlistData] = useState<Netlist | null>(null);
  const [currentFile, setCurrentFile] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Helper to validate netlist
  const isValidNetlist = (netlist: any) => {
    return netlist && Object.keys(netlist.instances || {}).length > 0;
  };

  useEffect(() => {
    if (vscode) {
      // VSCode environment
      vscode.postMessage({ command: "ready" });

      const messageHandler = (event: MessageEvent) => {
        const message = event.data;

        switch (message.command) {
          case "update":
            setIsLoading(false);
            setLoadError(null);
            // Only update netlist if it's valid, otherwise keep the old one
            if (isValidNetlist(message.netlist)) {
              setNetlistData(message.netlist);
            }
            setCurrentFile(message.currentFile);
            break;
          default:
            console.warn("Unknown command received:", message);
        }
      };

      window.addEventListener("message", messageHandler);

      return () => {
        window.removeEventListener("message", messageHandler);
      };
    } else {
      // Browser environment - use demo data
      setIsLoading(false);
      setNetlistData(demoData as Netlist);
      setCurrentFile(
        "/Users/lenny/code/stdlib/boards/dev_tusb4020/eval_tusb4020.ato:Usb1v1.buck"
      );
    }
  }, []);

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
        ) : !netlistData ? (
          <div className="loading">Waiting for netlist data...</div>
        ) : (
          <SchematicContainer
            netlistData={netlistData}
            currentFile={currentFile ?? ""}
          />
        )}
      </main>
    </div>
  );
}

export default App;
