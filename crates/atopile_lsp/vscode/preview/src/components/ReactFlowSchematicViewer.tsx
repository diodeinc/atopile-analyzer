import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ELK as ELKType } from "elkjs/lib/elk-api";
import {
  ReactFlow,
  Controls,
  MiniMap,
  Edge,
  Position,
  useNodesState,
  useEdgesState,
  Handle,
  EdgeProps,
  EdgeTypes,
  type Node,
  useOnSelectionChange,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ElkEdge,
  ElkGraph,
  ElkNode,
  NodeType,
  SchematicRenderer,
} from "../renderer";
import { Netlist } from "../types/NetlistTypes";
import { debounce } from "lodash";

type SelectionState = {
  selectedNetId: string | null;
  hoveredNetId: string | null;
};

type SchematicNodeData = ElkNode & {
  componentType: NodeType;
  selectionState: SelectionState;
} & Record<string, unknown>;

type SchematicEdgeData = ElkEdge & {
  selectionState: SelectionState;
} & Record<string, unknown>;

type SchematicNode = Node<SchematicNodeData, NodeType>;
type SchematicEdge = Edge<SchematicEdgeData>;

function createSchematicNode(
  elkNode: ElkNode,
  selectionState: SelectionState
): SchematicNode {
  return {
    id: elkNode.id,
    data: {
      componentType: elkNode.type,
      selectionState,
      ...elkNode,
    },
    position: { x: elkNode.x || 0, y: elkNode.y || 0 },
    type: elkNode.type,
    draggable: false,
    // Only make modules selectable
    selectable: elkNode.type === NodeType.MODULE,
    connectable: false,
    // Add custom styles based on node type
    style: {
      // Prevent hover effects on component nodes
      ...(elkNode.type === NodeType.COMPONENT
        ? {
            cursor: "default",
            // Add some !important styles but NOT transform
            backgroundColor: "#f5f5f5 !important",
            border: "1px solid #ddd !important",
            boxShadow: "none !important",
          }
        : {}),
    },
    // Add class for additional styling with CSS
    className:
      elkNode.type === NodeType.MODULE
        ? "module-node"
        : "component-node non-interactive",
  };
}

function createSchematicEdge(
  elkEdge: ElkEdge,
  selectionState: SelectionState
): SchematicEdge {
  return {
    id: elkEdge.id,
    data: { ...elkEdge, selectionState },
    source: elkEdge.sourceComponentRef,
    target: elkEdge.targetComponentRef,
    sourceHandle: `${elkEdge.sources[0]}-source`,
    targetHandle: `${elkEdge.targets[0]}-target`,
    type: "electrical",
  };
}

// Custom CSS to override ReactFlow default hover effects
const customStyles = `
  /* Use VSCode theme colors for nodes and edges with fallbacks */
  .react-flow__node {
    color: var(--vscode-foreground, #000);
    border-color: var(--vscode-descriptionForeground, #666);
  }

  .react-flow__edge {
    stroke: var(--vscode-descriptionForeground, #666);
  }

  .react-flow__edge-path {
    stroke: var(--vscode-descriptionForeground, #666) !important;
  }

  /* Style the graph background */
  .react-flow {
    background-color: var(--vscode-editor-background, #fff);
  }

  /* Disable hover effects for component nodes */
  .react-flow__node-componentNode {
    pointer-events: none !important;
  }
  
  .react-flow__node-componentNode .component-port {
    pointer-events: auto !important;
  }
  
  /* Prevent hover color change for component nodes */
  .react-flow__node-componentNode:hover {
    background-color: var(--vscode-editor-background, #f5f5f5) !important;
    border-color: var(--vscode-descriptionForeground, #666) !important;
    box-shadow: none !important;
    cursor: default !important;
  }
  
  /* Keep module nodes interactive */
  .react-flow__node-moduleNode {
    cursor: pointer;
  }

  /* Module node hover state */
  .react-flow__node-moduleNode:hover {
    border-color: var(--vscode-focusBorder, #0066cc) !important;
    box-shadow: 0 0 0 2px var(--vscode-focusBorder, #0066cc) !important;
  }
  
  /* Make sure the port connection points remain interactive */
  .react-flow__handle {
    pointer-events: all !important;
  }

  /* Style the minimap */
  .react-flow__minimap {
    background-color: var(--vscode-editor-background, #fff);
  }

  /* Style the controls */
  .react-flow__controls {
    background-color: var(--vscode-editor-background, #fff);
    border-color: var(--vscode-descriptionForeground, #666);
  }

  .react-flow__controls button {
    background-color: var(--vscode-button-background, #0066cc);
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-border, transparent);
  }

  .react-flow__controls button:hover {
    background-color: var(--vscode-button-hoverBackground, #0052a3);
  }

  /* Style port labels */
  .port-label {
    color: var(--vscode-descriptionForeground, #666);
  }
`;

// Common style for all handles - subtle dots on component borders
const portHandleStyle = {
  background: "var(--vscode-descriptionForeground, #666)",
  border: `1px solid var(--vscode-descriptionForeground, #666)`,
  borderRadius: "50%",
  width: "4px",
  height: "4px",
  opacity: 0.5,
  zIndex: 20,
};

// Define custom node component for modules and components
const ModuleNode = ({ data }: { data: SchematicNodeData }) => {
  // Find the original component to determine its type
  const isModule = data.componentType === NodeType.MODULE;

  return (
    <div
      className={`react-flow-${isModule ? "module" : "component"}-node`}
      style={{
        width: data.width,
        height: data.height,
        backgroundColor: "var(--vscode-editor-background, #fff)",
        border: "1px solid var(--vscode-descriptionForeground, #666)",
        opacity: 0.9,
        cursor: isModule ? "pointer" : "default",
        pointerEvents: isModule ? "auto" : "none", // Only enable pointer events for modules
      }}
    >
      {/* Component/Module label - top left corner */}
      <div
        className={`${isModule ? "module" : "component"}-header`}
        style={{
          position: "absolute",
          top: data.labels?.[0]?.y,
          left: data.labels?.[0]?.x,
          padding: "4px",
          fontSize: "12px",
          fontWeight: "bold",
          color: "var(--vscode-foreground, #000)",
        }}
      >
        {data.labels?.[0]?.text}
      </div>

      {/* Port connections */}
      <div className={`${isModule ? "module" : "component"}-content`}>
        {data.ports && data.ports.length > 0 && (
          <div className={`${isModule ? "module" : "component"}-ports`}>
            {data.ports.map((port) => {
              // Calculate port position relative to node
              let position = "left";
              if (port.properties && port.properties["port.side"]) {
                // Use ELK-provided port side if available
                const side = port.properties["port.side"];
                position =
                  side === "WEST"
                    ? "left"
                    : side === "EAST"
                    ? "right"
                    : side === "NORTH"
                    ? "top"
                    : "bottom";
              } else {
                // Otherwise determine based on position within node
                const tolerance = 20; // Pixels from edge to consider as boundary
                if (port.x && port.x <= tolerance) position = "left";
                else if (port.x && port.x >= (data.width || 0) - tolerance)
                  position = "right";
                else if (port.y && port.y <= tolerance) position = "top";
                else if (port.y && port.y >= (data.height || 0) - tolerance)
                  position = "bottom";
              }

              // Set label position relative to port based on which side it's on
              const labelStyle = {
                position: "absolute" as const,
                fontSize: "10px",
                whiteSpace: "nowrap" as const,
                pointerEvents: "none" as const,
                transform: "",
                textAlign: "left" as React.CSSProperties["textAlign"],
                width: position === "right" ? "auto" : "70px", // Auto width for right labels
                maxWidth: position === "right" ? "150px" : "70px", // Add maxWidth to prevent extreme stretching
                right: position === "right" ? "0px" : "auto", // Position from right edge for right-side labels
                left: position === "right" ? "auto" : undefined, // Don't set left for right-side labels
              };

              // Position label based on port side
              switch (position) {
                case "left":
                  labelStyle.transform = "translate(10px, -5px)";
                  labelStyle.textAlign = "left";
                  break;
                case "right":
                  labelStyle.transform = "translate(-10px, -5px)"; // More symmetrical offset
                  labelStyle.textAlign = "right";
                  break;
                case "top":
                  labelStyle.transform = "translate(-30px, 10px)";
                  break;
                case "bottom":
                  labelStyle.transform = "translate(-30px, -15px)";
                  break;
              }

              return (
                <div
                  key={port.id}
                  className={`${isModule ? "module" : "component"}-port`}
                  style={{
                    position: "absolute",
                    left: port.x,
                    top: port.y,
                    width: 0,
                    height: 0,
                    borderRadius: "50%",
                    backgroundColor: "#000",
                    opacity: 0.7,
                    zIndex: 10,
                    pointerEvents: "auto", // Enable pointer events for ports only
                  }}
                  data-port-id={port.id}
                >
                  {/* Hidden connection handles that React Flow needs for connections */}
                  <Handle
                    type="source"
                    position={
                      position === "left"
                        ? Position.Left
                        : position === "right"
                        ? Position.Right
                        : position === "top"
                        ? Position.Top
                        : Position.Bottom
                    }
                    id={`${port.id}-source`}
                    style={{ ...portHandleStyle, opacity: 0 }}
                  />
                  <Handle
                    type="target"
                    position={
                      position === "left"
                        ? Position.Left
                        : position === "right"
                        ? Position.Right
                        : position === "top"
                        ? Position.Top
                        : Position.Bottom
                    }
                    id={`${port.id}-target`}
                    style={{ ...portHandleStyle, opacity: 0 }}
                  />

                  {/* Port label */}
                  <div className="port-label" style={labelStyle}>
                    {port.labels?.[0]?.text}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

// Define a node specifically for capacitors with authentic schematic symbol
const CapacitorNode = ({ data }: { data: any }) => {
  // Calculate center point for drawing the symbol
  const centerX = data.width / 2;

  // Size of the capacitor symbol
  const symbolSize = 20;

  // Gap between capacitor plates
  const plateGap = 6;

  // Line length (distance from port to capacitor plate)
  const lineLength = (data.height - plateGap - 4) / 2;

  // Determine if this node should be dimmed based on selection state
  const selectionState = data.selectionState;
  const shouldDim =
    selectionState?.selectedNetId || selectionState?.hoveredNetId;
  const isConnectedToHighlightedNet =
    shouldDim &&
    data.ports?.some((port: any) => {
      const netId = port.netId;
      return (
        netId === selectionState.selectedNetId ||
        netId === selectionState.hoveredNetId
      );
    });
  const opacity = shouldDim && !isConnectedToHighlightedNet ? 0.2 : 1;

  return (
    <div
      className="react-flow-capacitor-node"
      style={{
        width: data.width,
        height: data.height,
        backgroundColor: "transparent",
        border: "none",
        cursor: "default",
        pointerEvents: "none",
        position: "relative",
        transform: "translate(-0.75px, 1px)",
        opacity: opacity,
      }}
    >
      {/* Capacitor Symbol */}
      <div
        className="capacitor-symbol"
        style={{
          position: "absolute",
          width: data.width,
          height: data.height,
        }}
      >
        {/* Top vertical line connecting port to top plate */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: centerX,
            width: "1.5px",
            height: lineLength,
            backgroundColor: "var(--vscode-descriptionForeground, #666)",
          }}
        />

        {/* Top capacitor plate */}
        <div
          style={{
            position: "absolute",
            top: lineLength,
            left: centerX - symbolSize / 2,
            width: symbolSize,
            height: "2px",
            backgroundColor: "var(--vscode-descriptionForeground, #666)",
          }}
        />

        {/* Bottom capacitor plate */}
        <div
          style={{
            position: "absolute",
            top: lineLength + plateGap, // Gap between plates
            left: centerX - symbolSize / 2,
            width: symbolSize,
            height: "2px",
            backgroundColor: "var(--vscode-descriptionForeground, #666)",
          }}
        />

        {/* Bottom vertical line connecting bottom plate to port */}
        <div
          style={{
            position: "absolute",
            top: lineLength + plateGap + 2, // Position after bottom plate
            left: centerX,
            width: "1.5px",
            height: lineLength,
            backgroundColor: "var(--vscode-descriptionForeground, #666)",
          }}
        />

        {/* Component Label */}
        {data.labels?.[0] && (
          <div
            style={{
              position: "absolute",
              left: centerX + symbolSize + 10, // Position to the right of the symbol
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: "12px",
              color: "var(--vscode-foreground, #000)",
              whiteSpace: "pre-line", // Preserve line breaks from renderer
              width: data.labels?.[0]?.width,
              height: data.labels?.[0]?.height,
              textAlign: "left", // Ensure left alignment
              display: "flex", // Use flexbox for better alignment
              alignItems: "center", // Center content vertically
            }}
          >
            {data.labels[0].text}
          </div>
        )}
      </div>

      {/* Hidden port connections with no visible dots */}
      <div className="component-ports">
        {/* Port 1 - Top */}
        <div
          key={data.ports[0].id}
          className="component-port"
          style={{
            position: "absolute",
            left: centerX,
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            zIndex: 10,
            pointerEvents: "auto", // Enable pointer events for ports only
          }}
          data-port-id={data.ports[0].id}
        >
          {/* Top port handle */}
          <Handle
            type="source"
            position={Position.Top}
            id={`${data.ports[0].id}-source`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
          <Handle
            type="target"
            position={Position.Top}
            id={`${data.ports[0].id}-target`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
        </div>

        {/* Port 2 - Bottom */}
        <div
          key={data.ports[1].id}
          className="component-port"
          style={{
            position: "absolute",
            left: centerX,
            top: data.height,
            width: 1,
            height: 1,
            opacity: 0,
            zIndex: 10,
            pointerEvents: "auto", // Enable pointer events for ports only
          }}
          data-port-id={data.ports[1].id}
        >
          {/* Bottom port handle */}
          <Handle
            type="source"
            position={Position.Bottom}
            id={`${data.ports[1].id}-source`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
          <Handle
            type="target"
            position={Position.Bottom}
            id={`${data.ports[1].id}-target`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
        </div>
      </div>
    </div>
  );
};

// Define a node specifically for resistors with authentic schematic symbol
const ResistorNode = ({ data }: { data: any }) => {
  // Calculate center point for drawing the symbol
  const centerX = data.width / 2;

  // Resistor dimensions
  const resistorHeight = 40;
  const resistorWidth = 20;
  const lineLength = (data.height - resistorHeight) / 2;

  // Determine if this node should be dimmed based on selection state
  const selectionState = data.selectionState;
  const shouldDim =
    selectionState?.selectedNetId || selectionState?.hoveredNetId;
  const isConnectedToHighlightedNet =
    shouldDim &&
    data.ports?.some((port: any) => {
      const netId = port.netId;
      return (
        netId === selectionState.selectedNetId ||
        netId === selectionState.hoveredNetId
      );
    });
  const opacity = shouldDim && !isConnectedToHighlightedNet ? 0.2 : 1;

  // Zigzag parameters for a more professional look
  const numZigzags = 4;
  const zigzagWidth = resistorWidth;

  // Generate zigzag points for a smoother, more professional look
  let zigzagPoints = "";

  // Start from the top center
  zigzagPoints += `${centerX},${lineLength}`;

  // Create zigzag pattern
  for (let i = 0; i < numZigzags; i++) {
    const segmentHeight = resistorHeight / numZigzags;
    const y1 = lineLength + i * segmentHeight;
    const y2 = lineLength + (i + 1) * segmentHeight;

    // Right point
    zigzagPoints += ` ${centerX + zigzagWidth / 2},${y1 + segmentHeight / 4}`;
    // Left point
    zigzagPoints += ` ${centerX - zigzagWidth / 2},${y2 - segmentHeight / 4}`;
  }

  // End at bottom center
  zigzagPoints += ` ${centerX},${lineLength + resistorHeight}`;

  return (
    <div
      className="react-flow-resistor-node"
      style={{
        width: data.width,
        height: data.height,
        backgroundColor: "transparent",
        border: "none",
        cursor: "default",
        pointerEvents: "none",
        position: "relative",
        opacity: opacity,
        transform: "translate(-0.3px, 0px)",
      }}
    >
      {/* Resistor Symbol */}
      <div
        className="resistor-symbol"
        style={{
          position: "absolute",
          width: data.width,
          height: data.height,
        }}
      >
        {/* Top line connecting to resistor */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: centerX - 0.75,
            width: "1.5px",
            height: lineLength,
            backgroundColor: "var(--vscode-descriptionForeground, #666)",
          }}
        />

        {/* Resistor body (zigzag) */}
        <svg
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: data.width,
            height: data.height,
          }}
        >
          <polyline
            points={zigzagPoints}
            fill="none"
            stroke="var(--vscode-descriptionForeground, #666)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>

        {/* Bottom line connecting to resistor */}
        <div
          style={{
            position: "absolute",
            top: lineLength + resistorHeight,
            left: centerX - 0.75,
            width: "1.5px",
            height: lineLength,
            backgroundColor: "var(--vscode-descriptionForeground, #666)",
          }}
        />

        {/* Component Label */}
        {data.labels?.[0] && (
          <div
            style={{
              position: "absolute",
              left: centerX + resistorWidth + 10, // Position to the right of the symbol
              top: "50%",
              transform: "translateY(-50%)", // Center vertically
              fontSize: "12px",
              color: "var(--vscode-foreground, #000)",
              whiteSpace: "pre-line", // Preserve line breaks from renderer
              width: data.labels?.[0]?.width,
              height: data.labels?.[0]?.height,
              textAlign: "left", // Ensure left alignment
              display: "flex", // Use flexbox for better alignment
              alignItems: "center", // Center content vertically
            }}
          >
            {data.labels[0].text}
          </div>
        )}
      </div>

      {/* Hidden port connections with no visible dots */}
      <div className="component-ports">
        {/* Port 1 - Top */}
        <div
          key={data.ports[0].id}
          className="component-port"
          style={{
            position: "absolute",
            left: centerX,
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            zIndex: 10,
            pointerEvents: "auto",
          }}
          data-port-id={data.ports[0].id}
        >
          <Handle
            type="source"
            position={Position.Top}
            id={`${data.ports[0].id}-source`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
          <Handle
            type="target"
            position={Position.Top}
            id={`${data.ports[0].id}-target`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
        </div>

        {/* Port 2 - Bottom */}
        <div
          key={data.ports[1].id}
          className="component-port"
          style={{
            position: "absolute",
            left: centerX,
            top: data.height,
            width: 1,
            height: 1,
            opacity: 0,
            zIndex: 10,
            pointerEvents: "auto",
          }}
          data-port-id={data.ports[1].id}
        >
          <Handle
            type="source"
            position={Position.Bottom}
            id={`${data.ports[1].id}-source`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
          <Handle
            type="target"
            position={Position.Bottom}
            id={`${data.ports[1].id}-target`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
        </div>
      </div>
    </div>
  );
};

// Define a node specifically for inductors with authentic schematic symbol
const InductorNode = ({ data }: { data: SchematicNodeData }) => {
  // Calculate center point for drawing the symbol
  const centerX = (data.width || 0) / 2;

  // Size of the inductor symbol
  const inductorHeight = 40;
  const numArcs = 4;
  const arcRadius = inductorHeight / (2 * numArcs);
  const lineLength = ((data.height || 0) - inductorHeight) / 2;

  // Number of arcs

  // Determine if this node should be dimmed based on selection state
  const selectionState = data.selectionState;
  const shouldDim =
    selectionState?.selectedNetId || selectionState?.hoveredNetId;
  const isConnectedToHighlightedNet =
    shouldDim &&
    data.ports?.some((port) => {
      const netId = port.netId;
      return (
        netId === selectionState.selectedNetId ||
        netId === selectionState.hoveredNetId
      );
    });
  const opacity = shouldDim && !isConnectedToHighlightedNet ? 0.2 : 1;

  return (
    <div
      className="react-flow-inductor-node"
      style={{
        width: data.width,
        height: data.height,
        backgroundColor: "transparent",
        border: "none",
        cursor: "default",
        pointerEvents: "none",
        position: "relative",
        opacity: opacity,
        transform: "translate(-0.2px, 0)",
      }}
    >
      {/* Inductor Symbol */}
      <div
        className="inductor-symbol"
        style={{
          position: "absolute",
          width: data.width,
          height: data.height,
        }}
      >
        {/* Top vertical line connecting to inductor */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: centerX - 0.75,
            width: "1.5px",
            height: lineLength,
            backgroundColor: "var(--vscode-descriptionForeground, #666)",
          }}
        />

        {/* Inductor arcs */}
        <svg
          style={{
            position: "absolute",
            top: lineLength,
            left: 0,
            width: data.width,
            height: inductorHeight,
          }}
        >
          <path
            d={`M ${centerX} 0 ${Array.from(
              { length: numArcs },
              (_, i) =>
                `A ${arcRadius} ${arcRadius} 0 0 0 ${centerX} ${
                  (i + 1) * 2 * arcRadius
                }`
            ).join(" ")}`}
            fill="none"
            stroke="var(--vscode-descriptionForeground, #666)"
            strokeWidth="1.5"
          />
        </svg>

        {/* Bottom vertical line connecting to inductor */}
        <div
          style={{
            position: "absolute",
            top: lineLength + inductorHeight,
            left: centerX - 0.75,
            width: "1.5px",
            height: lineLength,
            backgroundColor: "var(--vscode-descriptionForeground, #666)",
          }}
        />
      </div>

      {/* Hidden port connections with no visible dots */}
      <div className="component-ports">
        {/* Port 1 - Top */}
        <div
          key={data.ports?.[0]?.id}
          className="component-port"
          style={{
            position: "absolute",
            left: centerX,
            top: 0,
            width: 1,
            height: 1,
            opacity: 0,
            zIndex: 10,
            pointerEvents: "auto",
          }}
          data-port-id={data.ports?.[0]?.id}
        >
          <Handle
            type="source"
            position={Position.Top}
            id={`${data.ports?.[0]?.id}-source`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
          <Handle
            type="target"
            position={Position.Top}
            id={`${data.ports?.[0]?.id}-target`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
        </div>

        {/* Port 2 - Bottom */}
        <div
          key={data.ports?.[1]?.id}
          className="component-port"
          style={{
            position: "absolute",
            left: centerX,
            top: data.height,
            width: 1,
            height: 1,
            opacity: 0,
            zIndex: 10,
            pointerEvents: "auto",
          }}
          data-port-id={data.ports?.[1]?.id}
        >
          <Handle
            type="source"
            position={Position.Bottom}
            id={`${data.ports?.[1]?.id}-source`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
          <Handle
            type="target"
            position={Position.Bottom}
            id={`${data.ports?.[1]?.id}-target`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
        </div>
      </div>
    </div>
  );
};

// Define a node specifically for net references with an open circle symbol
const NetReferenceNode = ({ data }: { data: any }) => {
  // Calculate center point for drawing the symbol
  const centerX = data.width / 2;
  const centerY = data.height / 2;

  // Size of the net reference circle
  const circleRadius = data.width / 2 - 2;

  // Determine if this node should be dimmed based on selection state
  const selectionState = data.selectionState;
  const isSelected = data.netId === selectionState?.selectedNetId;
  const isHovered = data.netId === selectionState?.hoveredNetId;
  const shouldDim =
    (selectionState?.selectedNetId || selectionState?.hoveredNetId) &&
    !isSelected &&
    !isHovered;
  const opacity = shouldDim ? 0.2 : 1;

  return (
    <div
      className="react-flow-net-reference-node"
      style={{
        width: data.width,
        height: data.height,
        backgroundColor: "white",
        borderRadius: "50%",
        border: "none",
        cursor: "default",
        pointerEvents: "none",
        position: "relative",
        transform: "translate(-50%, -50%)",
        opacity: opacity,
      }}
    >
      {/* Net Reference Symbol - Open Circle */}
      <div
        className="net-reference-symbol"
        style={{
          position: "absolute",
          width: data.width,
          height: data.height,
        }}
      >
        <svg
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
          }}
        >
          <circle
            cx={centerX}
            cy={centerY}
            r={circleRadius}
            stroke="var(--vscode-descriptionForeground, #666)"
            strokeWidth="1.5"
            fill="transparent"
          />
        </svg>
      </div>

      {/* Single port for net reference */}
      <div className="component-ports">
        <div
          key={data.ports[0].id}
          className="component-port"
          style={{
            position: "absolute",
            left: centerX,
            top: centerY,
            width: 1,
            height: 1,
            opacity: 0,
            zIndex: 10,
            pointerEvents: "auto", // Enable pointer events for port only
          }}
          data-port-id={data.ports[0].id}
        >
          {/* Single handle that will be used for all connections */}
          <Handle
            type="source"
            position={Position.Left}
            id={`${data.ports[0].id}-source`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
          <Handle
            type="target"
            position={Position.Left}
            id={`${data.ports[0].id}-target`}
            style={{ ...portHandleStyle, opacity: 0 }}
          />
        </div>
      </div>

      {/* Net reference name/label */}
      {data.labels && data.labels[0] && (
        <div
          className="net-reference-label"
          style={{
            position: "absolute",
            top: centerY + circleRadius + 5,
            left: 0,
            width: "100%",
            textAlign: "center",
            fontSize: "10px",
            fontWeight: "bold",
            color: "var(--vscode-descriptionForeground, #666)",
          }}
        >
          {data.labels[0].text}
        </div>
      )}
    </div>
  );
};

// Define a node specifically for net junctions - invisible in the final rendering
const NetJunctionNode = ({ data }: { data: SchematicNodeData }) => {
  console.log(
    "Rendering net junction node with handles: ",
    data,
    `${data.ports?.[0]?.id}-source`,
    `${data.ports?.[0]?.id}-target`
  );
  return (
    <div
      className="react-flow-net-junction-node"
      style={{
        width: 10,
        height: 10,
        backgroundColor: "transparent",
        border: "none",
        cursor: "default",
        pointerEvents: "none",
        position: "relative",
        opacity: 0, // Make it completely invisible
      }}
    >
      <div className="module-ports" data-port-id={data.ports?.[0]?.id}>
        {/* Single handle for connections */}
        <Handle
          type="source"
          id={`${data.ports?.[0]?.id}-source`}
          position={Position.Left}
          style={{ opacity: 0 }}
        />
        <Handle
          type="target"
          id={`${data.ports?.[0]?.id}-target`}
          position={Position.Left}
          style={{ opacity: 0 }}
        />
        <Handle
          type="target"
          id={`${data.ports?.[0]?.id}`}
          position={Position.Left}
          style={{ opacity: 0 }}
        />
      </div>
    </div>
  );
};

// Define custom edge for electrical connections
const ElectricalEdge = ({
  id,
  data,
  interactionWidth,
  style = {},
}: EdgeProps<SchematicEdge>) => {
  // Get section data from the ElkEdge
  const section = data?.sections?.[0];

  // Build points array from section data
  let points = [
    // Start with the section's startPoint
    { x: section?.startPoint?.x || 0, y: section?.startPoint?.y || 0 },
    // Add any bend points from the section
    ...(section?.bendPoints || []),
    // End with the section's endPoint
    { x: section?.endPoint?.x || 0, y: section?.endPoint?.y || 0 },
  ];

  // Build path data string with straight lines (L commands)
  let pathData = `M${points[0].x},${points[0].y}`;

  for (let i = 1; i < points.length; i++) {
    pathData += ` L${points[i].x},${points[i].y}`;
  }

  // Determine if this edge should be dimmed based on selection state
  const selectionState = data?.selectionState;
  const isSelected = data?.netId === selectionState?.selectedNetId;
  const isHovered = data?.netId === selectionState?.hoveredNetId;
  const shouldDim =
    (selectionState?.selectedNetId || selectionState?.hoveredNetId) &&
    !isSelected &&
    !isHovered;
  const opacity = shouldDim ? 0.2 : 1;

  return (
    <>
      <path
        id={id}
        style={{
          strokeWidth: 1.5,
          stroke: "var(--vscode-descriptionForeground, #666)",
          pointerEvents: "none",
          ...style,
          opacity: opacity,
        }}
        className="react-flow__edge-path electrical-edge straight-line"
        d={pathData}
      />

      <path
        d={pathData}
        fill="none"
        strokeOpacity={0}
        strokeWidth={interactionWidth}
        className="react-flow__edge-interaction"
      />

      {/* Render junction points if they exist */}
      {data?.junctionPoints &&
        data.junctionPoints.map(
          (point: { x: number; y: number }, index: number) => (
            <circle
              key={`junction-${id}-${index}`}
              cx={point.x}
              cy={point.y}
              r={3.5}
              fill={style.stroke || "var(--vscode-descriptionForeground, #666)"}
              style={{
                ...style,
                opacity: opacity,
              }}
              className="electrical-junction-point"
            />
          )
        )}
    </>
  );
};

// Define edge types
const edgeTypes: EdgeTypes = {
  electrical: ElectricalEdge,
};

// Define node types
const nodeTypes = {
  module: ModuleNode,
  component: ModuleNode,
  capacitor: CapacitorNode,
  resistor: ResistorNode,
  inductor: InductorNode,
  net_reference: NetReferenceNode,
  net_junction: NetJunctionNode,
};

interface ReactFlowSchematicViewerProps {
  netlist: Netlist;
  onError?: (message: string) => void;
  onComponentSelect?: (componentId: string | null) => void;
  selectedComponent?: string | null;
}

const Visualizer = ({
  netlist,
  onComponentSelect = () => {},
  selectedComponent = null,
}: {
  netlist: Netlist;
  onComponentSelect?: (componentId: string | null) => void;
  selectedComponent?: string | null;
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState<SchematicNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SchematicEdge>([]);
  const [elkLayout, setElkLayout] = useState<ElkGraph | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [selectionState, setSelectionState] = useState<SelectionState>({
    selectedNetId: null,
    hoveredNetId: null,
  });
  const elkInstance = useRef<ELKType | null>(null);
  const reactFlowInstance = useRef<any>(null);

  // Create separate debounced functions for each state field
  const debouncedSetSelectedNet = useMemo(
    () =>
      debounce((selectedNetId: string | null) => {
        setSelectionState((prev) => ({
          ...prev,
          selectedNetId,
        }));
      }, 200), // Slightly longer debounce for selection
    []
  );

  const debouncedSetHoveredNet = useMemo(
    () =>
      debounce((hoveredNetId: string | null) => {
        setSelectionState((prev) => ({
          ...prev,
          hoveredNetId,
        }));
      }, 100), // Shorter debounce for hover to feel more responsive
    []
  );

  // Cleanup debounced functions on unmount
  useEffect(() => {
    return () => {
      debouncedSetSelectedNet.cancel();
      debouncedSetHoveredNet.cancel();
    };
  }, [debouncedSetSelectedNet, debouncedSetHoveredNet]);

  // Initialize ELK engine
  useEffect(() => {
    elkInstance.current = new ELK();
  }, []);

  useEffect(() => {
    async function render() {
      const renderer = new SchematicRenderer(netlist);
      if (selectedComponent) {
        console.log("Rendering selected component: ", selectedComponent);
        try {
          let layout = await renderer.render(selectedComponent);
          setElkLayout(layout as ElkGraph);
          // Center the view after new component is rendered
          setTimeout(() => {
            reactFlowInstance.current?.fitView({
              padding: 0.2,
              duration: 200,
            });
          }, 10);
        } catch (error) {
          console.error("Error rendering component: ", error);
          setLayoutError(
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      }
    }

    render();
  }, [netlist, selectedComponent]);

  // Update nodes and edges when layout changes
  useEffect(() => {
    if (elkLayout) {
      const nodes = elkLayout.children.map((elkNode) =>
        createSchematicNode(elkNode, selectionState)
      );
      setNodes(nodes);

      const edges = elkLayout.edges.map((elkEdge) =>
        createSchematicEdge(elkEdge, selectionState)
      );
      console.log("Setting edges: ", edges);
      setEdges(edges);
    }
  }, [elkLayout, setNodes, setEdges, selectionState]);

  // Handle node click to select a component - only if the component is clickable (modules)
  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();

      // Check if the node is a module (which should be clickable)
      const nodeData = node.data as SchematicNodeData;
      if (nodeData.componentType === NodeType.MODULE) {
        onComponentSelect(node.id);
      }
    },
    [onComponentSelect]
  );

  useOnSelectionChange({
    onChange: useCallback(
      ({ nodes, edges }) => {
        console.log("Selection changed: ", nodes, edges);

        let selectedNetId =
          edges.length > 0 ? (edges[0].data?.netId as string) : null;

        if (selectedNetId !== selectionState.selectedNetId) {
          debouncedSetSelectedNet(selectedNetId);
        }
      },
      [selectionState.selectedNetId, debouncedSetSelectedNet]
    ),
  });

  return (
    <div className="schematic-viewer">
      <style>{customStyles}</style>

      {layoutError && (
        <div
          className="error-message"
          style={{
            color: "var(--vscode-errorForeground, #f44336)",
            backgroundColor:
              "var(--vscode-inputValidation-errorBackground, #fde7e9)",
            border:
              "1px solid var(--vscode-inputValidation-errorBorder, #f44336)",
            padding: "10px",
            margin: "10px",
            borderRadius: "4px",
          }}
        >
          <h3>Layout Error</h3>
          <p>{layoutError}</p>
        </div>
      )}

      <div
        className="react-flow-schematic-viewer"
        style={{
          backgroundColor: "var(--vscode-editor-background, #fff)",
          color: "var(--vscode-foreground, #000)",
          height: "100%",
          width: "100%",
        }}
      >
        <ReactFlow
          proOptions={{ hideAttribution: true }}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          onInit={(instance) => {
            reactFlowInstance.current = instance;
          }}
          onNodeClick={handleNodeClick}
          onEdgeMouseEnter={(_event, edge) => {
            if (
              edge.data?.netId &&
              edge.data?.netId !== selectionState.selectedNetId &&
              edge.data?.netId !== selectionState.hoveredNetId
            ) {
              debouncedSetHoveredNet(edge.data?.netId);
            }
          }}
          onEdgeMouseLeave={() => {
            debouncedSetHoveredNet(null);
          }}
          defaultEdgeOptions={{
            type: "electrical",
            style: {
              stroke: "var(--vscode-descriptionForeground, #666)",
              strokeWidth: 1.5,
            },
            interactionWidth: 10,
          }}
          style={{
            backgroundColor: "var(--vscode-editor-background, #fff)",
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          selectNodesOnDrag={false}
          zoomOnScroll={true}
          panOnScroll={true}
          panOnDrag={true}
          preventScrolling={false}
        >
          <Controls showInteractive={false} />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  );
};

const ReactFlowSchematicViewer = ({
  netlist,
  onComponentSelect = () => {},
  selectedComponent = null,
}: ReactFlowSchematicViewerProps) => {
  return (
    <ReactFlowProvider>
      <Visualizer
        netlist={netlist}
        onComponentSelect={onComponentSelect}
        selectedComponent={selectedComponent}
      />
    </ReactFlowProvider>
  );
};

export default ReactFlowSchematicViewer;
