import React, { useState, useEffect, useRef, useMemo } from "react";
import ReactFlowSchematicViewer from "./ReactFlowSchematicViewer";
import "./ReactFlowSchematicViewer.css";
import { HierarchicalSchematic } from "../types";
import { AtopileNetlistConverter } from "../converters";
import {
  Netlist,
  Instance,
  ModuleRef,
  InstanceKind,
} from "../types/NetlistTypes";
import "@vscode-elements/elements/dist/bundled.js";
import {
  TreeItem,
  VscodeTree,
} from "@vscode-elements/elements/dist/vscode-tree/vscode-tree";

// Adjust styles for VSCode-like appearance
const containerStyles = `
.schematic-layout {
  display: flex;
  width: 100%;
  height: 100vh;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  font-size: 13px;
  background-color: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-foreground, #cccccc);
}

.schematic-sidebar {
  width: 260px;
  height: 100%;
  background-color: var(--vscode-sideBar-background, #252526);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--vscode-sideBar-border, #1e1e1e);
  box-sizing: border-box;
}

.file-tree-container {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  width: 100%;
  text-align: left;
}

// .vscode-tree {
//   height: 100%;
//   overflow-y: auto;
//   width: 100%;
// }

// .vscode-tree ul {
//   list-style-type: none;
//   padding: 0;
//   margin: 0;
// }

// .vscode-tree-item {
//   height: 22px;
//   cursor: pointer;
//   display: flex;
//   align-items: center;
//   color: var(--vscode-sideBarTitle-foreground, #bbbbbb);
// }

// .vscode-tree-item:hover {
//   background-color: var(--vscode-list-hoverBackground, rgba(90, 93, 94, 0.1));
// }

// .vscode-tree-item.selected {
//   background-color: var(--vscode-list-activeSelectionBackground, #094771) !important;
//   color: var(--vscode-list-activeSelectionForeground, #ffffff) !important;
// }

// .vscode-tree-item-content {
//   display: flex;
//   align-items: center;
//   height: 100%;
//   width: 100%;
// }

// .tree-item-icon {
//   display: inline-flex;
//   margin-right: 4px;
//   flex-shrink: 0;
//   min-width: 14px;
// }

// .tree-item-toggle {
//   display: inline-flex;
//   align-items: center;
//   justify-content: center;
//   width: 16px;
//   height: 16px;
//   flex-shrink: 0;
//   min-width: 16px;
//   margin-right: 3px;
// }

// .tree-item-label {
//   flex: 1;
//   white-space: nowrap;
//   overflow: hidden;
//   text-overflow: ellipsis;
// }

.schematic-viewer-container {
  flex: 1;
  height: 100vh;
  position: relative;
  background-color: var(--vscode-editor-background, #1e1e1e);
  overflow: hidden;
}

.error-message {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  background-color: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--vscode-inputValidation-errorForeground, #ffffff);
  padding: 8px 12px;
  border-radius: 2px;
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  font-size: 13px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  max-width: 80%;
}
`;

// Create a style element to inject the styles
const StyleInjector = () => {
  useEffect(() => {
    const styleEl = document.createElement("style");
    styleEl.innerHTML = containerStyles;
    document.head.appendChild(styleEl);

    return () => {
      document.head.removeChild(styleEl);
    };
  }, []);

  return null;
};

interface SchematicContainerProps {
  netlistData: Netlist;
  showDebug?: boolean;
  viewerType?: "elkjs" | "reactflow";
}

const Sidebar = ({
  netlist,
  selectModule,
  selectedModule,
}: {
  netlist: Netlist;
  selectModule: (moduleId: string) => void;
  selectedModule: string;
}) => {
  const [treeItems, setTreeItems] = useState<TreeItem[]>([]);
  const treeRef = useRef<VscodeTree>(null);

  // Function to find and update the path to a module in the tree
  const findAndUpdatePath = (
    items: TreeItem[],
    target: string,
    currentPath: string = ""
  ): boolean => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemPath = currentPath ? `${currentPath}/${i}` : `${i}`;

      if (item.value === target) {
        return true;
      }
      if (item.subItems?.length) {
        const found = findAndUpdatePath(item.subItems, target, itemPath);
        if (found) {
          item.open = true;
          return true;
        }
      }
    }
    return false;
  };

  // Effect to process netlist into tree items
  useEffect(() => {
    const rootItems: TreeItem[] = [];

    const addItem = (
      pathParts: string[],
      instance: Instance,
      instanceRef: string
    ) => {
      let currentLevel = rootItems;
      let currentPath: string[] = [];

      // Process each part of the path
      for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        if (!part) continue;

        currentPath.push(part);
        const isLastPart = i === pathParts.length - 1;

        // Try to find existing node at this level
        let node = currentLevel.find(
          (item) =>
            item.value ===
            (i === 0
              ? part
              : `${currentPath[0]}:${currentPath.slice(1).join(".")}`)
        );

        if (!node) {
          // Create new node
          node = {
            label: part.split("/").pop() || part, // Always show just the filename part
            value:
              i === 0
                ? part
                : `${currentPath[0]}:${currentPath.slice(1).join(".")}`, // Keep full path in value
            subItems: [],
          };
          currentLevel.push(node);
        }

        // Prepare for next level
        if (!isLastPart) {
          if (!node.subItems) {
            node.subItems = [];
          }
          currentLevel = node.subItems;
        }
      }
    };

    // Process all instances
    for (const [instanceRef, instance] of Object.entries(netlist.instances)) {
      const [filename, path] = instanceRef.split(":");
      const pathParts = path ? [filename, ...path.split(".")] : [instanceRef];
      addItem(pathParts, instance, instanceRef);
    }

    // Sort items at each level
    const sortItems = (items: TreeItem[]) => {
      items.sort((a, b) => a.label.localeCompare(b.label));
      items.forEach((item) => {
        if (item.subItems?.length) {
          sortItems(item.subItems);
        }
      });
    };

    sortItems(rootItems);
    setTreeItems(rootItems);
  }, [netlist]);

  // Effect to expand tree when selectedModule changes
  useEffect(() => {
    if (selectedModule && treeItems.length > 0) {
      const newTreeItems = [...treeItems];
      findAndUpdatePath(newTreeItems, selectedModule);
      setTreeItems(newTreeItems);
    }
  }, [selectedModule]);

  const handleTreeAction = (e: CustomEvent) => {
    console.log(e);
  };

  const handleTreeSelect = (e: CustomEvent) => {
    let ref = e.detail.path.split("/").map((part: string) => Number(part));
    let item = treeRef.current?.getItemByPath(ref);
    if (item && item.value) {
      selectModule(item.value);
    }
  };

  useEffect(() => {
    if (treeRef.current) {
      let tree = treeRef.current;

      tree.addEventListener("vsc-tree-action", handleTreeAction);
      tree.addEventListener("vsc-tree-select", handleTreeSelect);

      return () => {
        tree.removeEventListener("vsc-tree-action", handleTreeAction);
        tree.removeEventListener("vsc-tree-select", handleTreeSelect);
      };
    }
  }, [treeRef]);

  return (
    <div className="schematic-sidebar">
      <div className="file-tree-container">
        <vscode-tree
          indent-guides
          arrows
          data={treeItems}
          show-icons
          ref={treeRef}
        />
      </div>
    </div>
  );
};

/**
 * Container component that manages the schematic hierarchy and navigation
 */
const SchematicContainer: React.FC<SchematicContainerProps> = ({
  netlistData,
  showDebug = false,
  viewerType = "reactflow",
}) => {
  const [schematic, setSchematic] = useState<HierarchicalSchematic | undefined>(
    undefined
  );
  const [selectedComponent, setSelectedComponent] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedModule, setSelectedModule] = useState<string>("");
  const [currentViewNode, setCurrentViewNode] = useState<string>("");

  // Create converter instance
  const converter = new AtopileNetlistConverter();

  // Process netlist data when selected module changes
  useEffect(() => {
    if (netlistData && selectedModule) {
      try {
        // Convert the netlist to our hierarchical format
        const convertedSchematic = converter.convert(netlistData);
        setSchematic(convertedSchematic);
        setError(null);
      } catch (err) {
        console.error("Error converting netlist:", err);
        setError(
          `Failed to process netlist data: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        setSchematic(undefined);
      }
    } else {
      setSchematic(undefined);
    }
  }, [netlistData, selectedModule]);

  // Handle component selection
  const handleComponentSelect = (componentId: string | null) => {
    if (componentId) {
      setSelectedModule(componentId);
      setCurrentViewNode(componentId);
    }
  };

  // Handle errors
  const handleError = (message: string) => {
    setError(message);
  };

  return (
    <div className="schematic-layout">
      <StyleInjector />

      <Sidebar
        netlist={netlistData}
        selectModule={handleComponentSelect}
        selectedModule={selectedModule}
      />

      {/* Main Schematic Viewer */}
      <div className="schematic-viewer-container">
        {error && (
          <div className="error-message">
            <p>{error}</p>
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {/* Schematic Viewer */}
        <ReactFlowSchematicViewer
          schematic={schematic}
          netlist={netlistData}
          showDebug={showDebug}
          onError={handleError}
          onComponentSelect={handleComponentSelect}
          selectedComponent={selectedModule}
        />
      </div>
    </div>
  );
};

export default SchematicContainer;
