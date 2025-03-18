import React, { useCallback, useEffect, useRef, useState } from "react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { SchematicLevel, HierarchicalSchematic } from "../types";
import {
  ElkEdge,
  ElkGraph,
  ElkNode,
  NodeType,
  SchematicRenderer,
} from "../renderer";
import { Netlist } from "../types/NetlistTypes";

type SchematicNodeData = ElkNode & {
  componentType: NodeType;
} & Record<string, unknown>;

type SchematicEdgeData = ElkEdge & Record<string, unknown>;

type SchematicNode = Node<SchematicNodeData, NodeType>;
type SchematicEdge = Edge<SchematicEdgeData>;

function createSchematicNode(elkNode: ElkNode): SchematicNode {
  return {
    id: elkNode.id,
    data: {
      componentType: elkNode.type,
      ...elkNode,
    },
    position: { x: elkNode.x, y: elkNode.y },
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

function createSchematicEdge(elkEdge: ElkEdge): SchematicEdge {
  return {
    id: elkEdge.id,
    data: { ...elkEdge },
    source: elkEdge.sourceComponentRef,
    target: elkEdge.targetComponentRef,
    sourceHandle: `${elkEdge.sources[0]}-source`,
    targetHandle: `${elkEdge.targets[0]}-target`,
    type: "electrical",
  };
}

// Custom CSS to override ReactFlow default hover effects
const customStyles = `
  /* Disable hover effects for component nodes */
  .react-flow__node-componentNode {
    pointer-events: none !important;
  }
  
  .react-flow__node-componentNode .component-port {
    pointer-events: auto !important;
  }
  
  /* Prevent hover color change for component nodes */
  .react-flow__node-componentNode:hover {
    background-color: #f5f5f5 !important;
    border-color: #ddd !important;
    box-shadow: none !important;
    cursor: default !important;
  }
  
  /* Keep module nodes interactive */
  .react-flow__node-moduleNode {
    cursor: pointer;
  }
  
  /* Make sure the port connection points remain interactive */
  .react-flow__handle {
    pointer-events: all !important;
  }
`;

// Common style for all handles - subtle dots on component borders
const portHandleStyle = {
  background: "#000",
  border: "1px solid #000",
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
        backgroundColor: isModule ? "#ffffff" : "#f5f5f5",
        border: "1px solid #ddd",
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
            backgroundColor: "black",
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
            backgroundColor: "black",
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
            backgroundColor: "black",
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
            backgroundColor: "black",
          }}
        />
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
  const resistorWidth = 20; // Slightly wider to make zigzags more pronounced
  const lineLength = (data.height - resistorHeight) / 2;

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
            backgroundColor: "black",
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
            stroke="black"
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
            backgroundColor: "black",
          }}
        />
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

// Define a node specifically for net references with an open circle symbol
const NetReferenceNode = ({ data }: { data: any }) => {
  // Calculate center point for drawing the symbol
  const centerX = data.width / 2;
  const centerY = data.height / 2;

  // Size of the net reference circle
  const circleRadius = data.width / 2 - 2;

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
            stroke="black"
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
          }}
        >
          {data.labels[0].text}
        </div>
      )}
    </div>
  );
};

// Define custom edge for electrical connections
const ElectricalEdge = ({ id, data, style = {} }: EdgeProps<SchematicEdge>) => {
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

  return (
    <>
      <path
        id={id}
        style={{
          strokeWidth: 1.5,
          stroke: "#000",
          ...style,
        }}
        className="react-flow__edge-path electrical-edge straight-line"
        d={pathData}
        // No marker for electrical connections
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
              fill="#000"
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
  net_reference: NetReferenceNode,
};

interface ReactFlowSchematicViewerProps {
  schematic: HierarchicalSchematic | undefined;
  netlist: Netlist;
  showDebug?: boolean;
  onError?: (message: string) => void;
  onComponentSelect?: (componentId: string | null) => void;
  selectedComponent?: string | null;
}

const ReactFlowSchematicViewer: React.FC<ReactFlowSchematicViewerProps> = ({
  schematic,
  netlist,
  showDebug = false,
  onError = () => {},
  onComponentSelect = () => {},
  selectedComponent = null,
}) => {
  const [nodes, setNodes, onNodesChange] = useNodesState<SchematicNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<SchematicEdge>([]);
  const [elkLayout, setElkLayout] = useState<ElkGraph | null>(null);
  const [currentLevel, setCurrentLevel] = useState<SchematicLevel | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const elkInstance = useRef<ELKType | null>(null);

  // Initialize ELK engine
  useEffect(() => {
    elkInstance.current = new ELK();
  }, []);

  // Update the current level when the schematic changes
  useEffect(() => {
    if (schematic) {
      const level = schematic.levels[schematic.currentLevelId];
      setCurrentLevel(level);
    }
  }, [schematic]);

  const calculateLayout = useCallback(async () => {
    const renderer = new SchematicRenderer(netlist);
    if (selectedComponent) {
      console.log("Rendering selected component: ", selectedComponent);
      try {
        let layout = await renderer.render(selectedComponent);
        setElkLayout(layout as ElkGraph);
      } catch (error) {
        console.error("Error rendering component: ", error);
        setLayoutError(
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    }
  }, [netlist, selectedComponent]);

  // Calculate layout when the current level changes
  useEffect(() => {
    if (currentLevel) {
      calculateLayout();
    }
  }, [currentLevel, calculateLayout]);

  // Convert ELK layout to React Flow nodes and edges
  const convertElkToReactFlow = useCallback(() => {
    return {
      nodes: elkLayout?.children ?? [],
      edges: elkLayout?.edges ?? [],
    };
  }, [elkLayout]);

  // Update nodes and edges when layout changes
  useEffect(() => {
    if (elkLayout) {
      const { nodes: newNodes, edges: newEdges } = convertElkToReactFlow();

      const nodes = newNodes.map((elkNode) => createSchematicNode(elkNode));
      setNodes(nodes);

      const edges = newEdges.map((elkEdge) => createSchematicEdge(elkEdge));
      setEdges(edges);
    }
  }, [elkLayout, convertElkToReactFlow, setNodes, setEdges]);

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

  // Add navigation breadcrumbs/path info
  const getCurrentPath = useCallback(() => {
    if (!schematic) return [];

    const currentHierarchy = schematic.hierarchyRefs.find(
      (ref) => ref.childId === schematic.currentLevelId
    );

    return currentHierarchy?.path || [];
  }, [schematic]);

  const path = getCurrentPath();

  return (
    <div className="schematic-viewer">
      {/* Add custom styles to override ReactFlow defaults */}
      <style>{customStyles}</style>

      {layoutError && (
        <div className="error-message">
          <h3>Layout Error</h3>
          <p>{layoutError}</p>
        </div>
      )}

      <div className="react-flow-schematic-viewer">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          onNodeClick={handleNodeClick}
          defaultEdgeOptions={{
            type: "electrical",
            style: { stroke: "#000", strokeWidth: 1.5 },
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
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>

      {showDebug && (
        <div className="debug-info">
          <h3>Debug Information</h3>
          <h4>Current Level: {currentLevel?.name}</h4>
          <pre>{JSON.stringify(currentLevel, null, 2)}</pre>
          <h4>Layout:</h4>
          <pre>{JSON.stringify(elkLayout, null, 2)}</pre>
        </div>
      )}
    </div>
  );
};

export default ReactFlowSchematicViewer;
