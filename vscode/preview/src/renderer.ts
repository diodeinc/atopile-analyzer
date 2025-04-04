import ELK from "elkjs/lib/elk-api.js";
import type { ELK as ELKType } from "elkjs/lib/elk-api";
import { InstanceKind, Netlist, AttributeValue } from "./types/NetlistTypes";
import { createCanvas } from "canvas";

export enum NodeType {
  META = "meta",
  MODULE = "module",
  COMPONENT = "component",
  RESISTOR = "resistor",
  CAPACITOR = "capacitor",
  INDUCTOR = "inductor",
  NET_REFERENCE = "net_reference",
  NET_JUNCTION = "net_junction",
}

export enum NetReferenceType {
  NORMAL = "normal",
  GROUND = "ground",
  VDD = "vdd",
}

export interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  ports?: ElkPort[];
  labels?: ElkLabel[];
  properties?: Record<string, string>;
  type: NodeType;
  netId?: string; // Only used for net reference nodes
  netReferenceType?: NetReferenceType; // Only used for net reference nodes
  children?: ElkNode[];
  edges?: ElkEdge[];
}

export interface ElkPort {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  labels?: ElkLabel[];
  properties?: Record<string, string>;
  netId?: string;
}

export interface ElkLabel {
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  textAlign?: "left" | "right" | "center";
  properties?: Record<string, string>;
}

export interface ElkEdge {
  id: string;
  netId: string;
  sources: string[];
  targets: string[];
  sourceComponentRef: string;
  targetComponentRef: string;
  labels?: ElkLabel[];
  junctionPoints?: { x: number; y: number }[];
  sections?: {
    id: string;
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: { x: number; y: number }[];
  }[];
  properties?: Record<string, string>;
}

export interface ElkGraph {
  id: string;
  children: ElkNode[];
  edges: ElkEdge[];
}

export interface NodeSizeConfig {
  module: {
    width: number;
    height: number;
  };
  component: {
    width: number;
    height: number;
  };
  resistor: {
    width: number;
    height: number;
  };
  capacitor: {
    width: number;
    height: number;
  };
  inductor: {
    width: number;
    height: number;
  };
  netReference: {
    width: number;
    height: number;
  };
  netJunction: {
    width: number;
    height: number;
  };
  ground: {
    width: number;
    height: number;
  };
  vdd: {
    width: number;
    height: number;
  };
}

export interface SchematicConfig {
  // Node size configuration
  nodeSizes: NodeSizeConfig;

  // Layout configuration - we'll add more options here later
  layout: {
    // Direction of the layout - will be passed to ELK
    direction: "LEFT" | "RIGHT" | "UP" | "DOWN";
    // Spacing between nodes
    spacing: number;
    // Padding around the entire layout
    padding: number;
    // Whether to explode modules into their component parts
    explodeModules: boolean;
  };

  // Visual configuration - we'll add more options here later
  visual: {
    // Whether to show port labels
    showPortLabels: boolean;
    // Whether to show component values
    showComponentValues: boolean;
    // Whether to show footprints
    showFootprints: boolean;
  };
}

export const DEFAULT_CONFIG: SchematicConfig = {
  nodeSizes: {
    module: {
      width: 256,
      height: 128,
    },
    component: {
      width: 256,
      height: 128,
    },
    resistor: {
      width: 40,
      height: 30,
    },
    capacitor: {
      width: 40,
      height: 20,
    },
    inductor: {
      width: 40,
      height: 40,
    },
    netReference: {
      width: 10,
      height: 10,
    },
    netJunction: {
      width: 10,
      height: 10,
    },
    ground: {
      width: 30,
      height: 50,
    },
    vdd: {
      width: 30,
      height: 10,
    },
  },
  layout: {
    direction: "LEFT",
    spacing: 10,
    padding: 20,
    explodeModules: false,
  },
  visual: {
    showPortLabels: true,
    showComponentValues: true,
    showFootprints: true,
  },
};

// Add this helper function before the SchematicRenderer class
function calculateTextDimensions(
  text: string,
  fontSize: number,
  fontFamily: string = "monospace",
  fontWeight: string = "normal"
): { width: number; height: number } {
  // Create a canvas for text measurement
  const canvas = createCanvas(1, 1);
  const context = canvas.getContext("2d");

  // Set font properties
  context.font = `${fontWeight} ${fontSize}px ${fontFamily}`;

  // For multiline text, split by newline and find the widest line
  const lines = text.split("\n");
  const lineHeight = fontSize * 1.2; // Standard line height multiplier
  const width = Math.max(
    ...lines.map((line) => context.measureText(line).width)
  );
  const height = lineHeight * lines.length;

  return { width, height };
}

export class SchematicRenderer {
  netlist: Netlist;
  elk: ELKType;
  nets: Map<string, Set<string>>;
  config: SchematicConfig;
  netNames: Map<string, string>;

  constructor(netlist: Netlist, config: Partial<SchematicConfig> = {}) {
    this.netlist = netlist;
    this.elk = new ELK({
      workerFactory: function (url) {
        const { Worker } = require("elkjs/lib/elk-worker.js"); // non-minified
        return new Worker(url);
      },
    });
    this.nets = this._generateNets();
    this.netNames = this._generateUniqueNetNames();
    // Merge provided config with defaults
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      // Deep merge for nested objects
      nodeSizes: {
        ...DEFAULT_CONFIG.nodeSizes,
        ...config.nodeSizes,
      },
      layout: {
        ...DEFAULT_CONFIG.layout,
        ...config.layout,
      },
      visual: {
        ...DEFAULT_CONFIG.visual,
        ...config.visual,
      },
    };
  }

  _generateNets(): Map<string, Set<string>> {
    // Implement Union-Find (Disjoint-Set) data structure
    class UnionFind {
      parent: Map<string, string> = new Map();
      rank: Map<string, number> = new Map();

      // Add a new element to the set
      add(x: string): void {
        if (!this.parent.has(x)) {
          this.parent.set(x, x); // Each element starts as its own parent
          this.rank.set(x, 0); // Initial rank is 0
        }
      }

      // Find the representative element of the set containing x (with path compression)
      find(x: string): string {
        if (x !== this.parent.get(x)) {
          this.parent.set(x, this.find(this.parent.get(x)!));
        }
        return this.parent.get(x)!;
      }

      // Union the sets containing x and y (union by rank)
      union(x: string, y: string): void {
        const rootX = this.find(x);
        const rootY = this.find(y);

        if (rootX === rootY) return;

        // Union by rank optimizes the tree height
        if (this.rank.get(rootX)! < this.rank.get(rootY)!) {
          this.parent.set(rootX, rootY);
        } else if (this.rank.get(rootX)! > this.rank.get(rootY)!) {
          this.parent.set(rootY, rootX);
        } else {
          this.parent.set(rootY, rootX);
          this.rank.set(rootX, this.rank.get(rootX)! + 1);
        }
      }

      // Get all sets as a map of representative elements to their members
      getSets(): Map<string, Set<string>> {
        const sets: Map<string, Set<string>> = new Map();

        for (const element of Array.from(this.parent.keys())) {
          const root = this.find(element);
          if (!sets.has(root)) {
            sets.set(root, new Set<string>());
          }
          sets.get(root)!.add(element);
        }

        return sets;
      }
    }

    // Create and initialize our Union-Find structure
    const uf = new UnionFind();

    // Traverse all instances in the netlist
    for (const instance of Object.values(this.netlist.instances)) {
      // Process all connections in each instance
      for (const connection of instance.connections) {
        const left = connection.left;
        const right = connection.right;

        // Add both ports to the Union-Find structure
        uf.add(left);
        uf.add(right);

        // Union the two ports (they are part of the same net)
        uf.union(left, right);
      }
    }

    // Get all the nets (connected component sets)
    const connectedSets = uf.getSets();

    // Reformat with more meaningful names
    const nets = new Map<string, Set<string>>();

    for (const set of Array.from(connectedSets.values())) {
      // Find the port with the shortest path after ':'
      let shortestPath = Array.from(set)
        .map((port) => {
          const parts = port.split(":");
          return parts.length > 1 ? parts[1] : port;
        })
        .reduce((shortest, current) =>
          current.length < shortest.length ? current : shortest
        );

      nets.set(shortestPath, set);
    }

    return nets;
  }

  getNets(): Map<string, Set<string>> {
    return this.nets;
  }

  _getAttributeValue(attr: AttributeValue | string | undefined): string | null {
    if (!attr) return null;
    if (typeof attr === "string") return attr;
    if (attr.String) return attr.String;
    if (attr.Boolean !== undefined) return String(attr.Boolean);
    if (attr.Number !== undefined) return String(attr.Number);
    return null;
  }

  _renderValue(value: string | AttributeValue | undefined): string | undefined {
    if (typeof value === "string") return value;
    if (value?.String) return value.String;
    if (value?.Number !== undefined) return String(value.Number);
    if (value?.Boolean !== undefined) return String(value.Boolean);
    if (value?.Physical !== undefined) return String(value.Physical);

    return undefined;
  }

  _isGndNet(net: Set<string>): boolean {
    return Array.from(net).some((port) => {
      // This is a hack to work around capacitors exposing a `power` interface that will make it
      // look like anything connected to `p2` is a ground net. We should really come up with
      // something better here.
      return (
        port.toLowerCase().endsWith(".gnd") &&
        !port.toLowerCase().endsWith(".power.gnd")
      );
    });
  }

  _isPowerNet(net: Set<string>): boolean {
    for (const portRef of Array.from(net)) {
      // Split the port reference into parts
      const parts = portRef.split(".");
      if (parts.length < 2) continue;
      if (parts[parts.length - 1] !== "vcc") continue;

      // Get the instance reference (everything before the last part)
      const instanceRef = parts.slice(0, -1).join(".");
      const instance = this.netlist.instances[instanceRef];
      if (!instance) continue;

      // Skip if this is a capacitor
      const parentInstanceRef = parts.slice(0, -2).join(".");
      const parentInstance = this.netlist.instances[parentInstanceRef];
      const parentType = this._getAttributeValue(
        parentInstance?.attributes.type
      );
      if (parentType === "capacitor") {
        continue;
      }

      // Check if this port is part of a Power interface
      if (instance.kind === InstanceKind.INTERFACE) {
        const interfaceType = instance.type_ref.module_name;
        if (interfaceType === "Power") {
          // Found a power interface that's not on a capacitor
          return true;
        }
      }
    }
    return false;
  }

  _getPortConnections(instance_ref: string): {
    p1: { isGnd: boolean; isPower: boolean };
    p2: { isGnd: boolean; isPower: boolean };
  } {
    const connections = {
      p1: { isGnd: false, isPower: false },
      p2: { isGnd: false, isPower: false },
    };

    // Check each net for connections to our ports
    for (const [, net] of Array.from(this.nets.entries())) {
      const p1Port = `${instance_ref}.p1`;
      const p2Port = `${instance_ref}.p2`;

      if (net.has(p1Port)) {
        connections.p1.isGnd = this._isGndNet(net);
        connections.p1.isPower = this._isPowerNet(net);
      }
      if (net.has(p2Port)) {
        connections.p2.isGnd = this._isGndNet(net);
        connections.p2.isPower = this._isPowerNet(net);
      }
    }

    return connections;
  }

  _determinePortSides(instance_ref: string): {
    p1Side: "NORTH" | "SOUTH";
    p2Side: "NORTH" | "SOUTH";
  } {
    const connections = this._getPortConnections(instance_ref);

    // Default orientation
    let p1Side: "NORTH" | "SOUTH" = "NORTH";
    let p2Side: "NORTH" | "SOUTH" = "SOUTH";

    // Handle various cases
    if (connections.p1.isGnd && !connections.p2.isGnd) {
      // If p1 is ground and p2 isn't, p1 should be south
      p1Side = "SOUTH";
      p2Side = "NORTH";
    } else if (connections.p2.isGnd && !connections.p1.isGnd) {
      // If p2 is ground and p1 isn't, p2 should be south
      p1Side = "NORTH";
      p2Side = "SOUTH";
    } else if (connections.p1.isPower && !connections.p2.isPower) {
      // If p1 is power and p2 isn't, p1 should be north
      p1Side = "NORTH";
      p2Side = "SOUTH";
    } else if (connections.p2.isPower && !connections.p1.isPower) {
      // If p2 is power and p1 isn't, p2 should be north
      p1Side = "SOUTH";
      p2Side = "NORTH";
    }
    // In all other cases (including both ground, both power, or neither),
    // we keep the default orientation

    return { p1Side, p2Side };
  }

  _resistorNode(instance_ref: string): ElkNode {
    const instance = this.netlist.instances[instance_ref];
    const footprint =
      this._getAttributeValue(instance.attributes.package) ||
      this._getAttributeValue(instance.attributes.footprint);

    const value = this._renderValue(instance.attributes.value);
    const showValue = this.config.visual.showComponentValues && value;
    const showFootprint = this.config.visual.showFootprints && footprint;

    // Get reference designator if available
    const refDes = instance.reference_designator;

    const { p1Side, p2Side } = this._determinePortSides(instance_ref);

    return {
      id: instance_ref,
      type: NodeType.RESISTOR,
      width: this.config.nodeSizes.resistor.width,
      height: this.config.nodeSizes.resistor.height,
      labels: [
        // Add reference designator label if available
        ...(refDes
          ? [
              {
                text: refDes,
                x: -15, // Position to the left of the component
                y: 10,
                width: 20,
                height: 10,
                textAlign: "right" as const,
              },
            ]
          : []),
        {
          text: `${showValue ? value : ""}${
            showFootprint ? `\n${footprint}` : ""
          }`,
          x: 35,
          y: 4,
          width: 128,
          height: 25,
          textAlign: "left" as const,
        },
      ],
      ports: [
        {
          id: `${instance_ref}.p1`,
          properties: {
            "port.side": p1Side,
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
        {
          id: `${instance_ref}.p2`,
          properties: {
            "port.side": p2Side,
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
      ],
      properties: {
        "elk.padding": "[top=10, left=10, bottom=10, right=10]",
        "elk.portConstraints": "FIXED_SIDE",
        "elk.nodeSize.minimum": "(40, 30)",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeLabels.placement": "INSIDE",
      },
    };
  }

  _capacitorNode(instance_ref: string): ElkNode {
    const instance = this.netlist.instances[instance_ref];
    const value = this._renderValue(instance.attributes.value);
    const footprint =
      this._getAttributeValue(instance.attributes.package) ||
      this._getAttributeValue(instance.attributes.footprint);

    const showValue = this.config.visual.showComponentValues && value;
    const showFootprint = this.config.visual.showFootprints && footprint;

    const { p1Side, p2Side } = this._determinePortSides(instance_ref);

    return {
      id: instance_ref,
      type: NodeType.CAPACITOR,
      width: this.config.nodeSizes.capacitor.width,
      height: this.config.nodeSizes.capacitor.height,
      labels: [
        // Add reference designator label if available
        ...(instance.reference_designator
          ? [
              {
                text: instance.reference_designator,
                x: -20, // Position to the left of the component
                y: 7,
                width: 20,
                height: 10,
                textAlign: "right" as const,
              },
            ]
          : []),
        {
          text: `${showValue ? value : ""}${
            showFootprint ? `\n${footprint}` : ""
          }`,
          x: 40,
          y: 2,
          width: 128,
          height: 20,
          textAlign: "left" as const,
        },
      ],
      ports: [
        {
          id: `${instance_ref}.p1`,
          properties: {
            "port.side": p1Side,
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
        {
          id: `${instance_ref}.p2`,
          properties: {
            "port.side": p2Side,
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
      ],
      properties: {
        "elk.padding": "[top=10, left=10, bottom=10, right=10]",
        "elk.portConstraints": "FIXED_SIDE",
        "elk.nodeSize.minimum": "(40, 20)",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeLabels.placement": "",
      },
    };
  }

  _inductorNode(instance_ref: string): ElkNode {
    const instance = this.netlist.instances[instance_ref];
    const value = this._renderValue(instance.attributes.value);
    const footprint =
      this._getAttributeValue(instance.attributes.package) ||
      this._getAttributeValue(instance.attributes.footprint);

    const showValue = this.config.visual.showComponentValues && value;
    const showFootprint = this.config.visual.showFootprints && footprint;

    // Get reference designator if available
    const refDes = instance.reference_designator;

    const { p1Side, p2Side } = this._determinePortSides(instance_ref);

    return {
      id: instance_ref,
      type: NodeType.INDUCTOR,
      width: this.config.nodeSizes.inductor.width,
      height: this.config.nodeSizes.inductor.height,
      labels: [
        // Add reference designator label if available
        ...(refDes
          ? [
              {
                text: refDes,
                x: -20, // Position to the left of the component
                y: 5,
                width: 15,
                height: 10,
                textAlign: "right" as const,
              },
            ]
          : []),
        {
          text: `${showValue ? value : ""}${
            showFootprint ? `\n${footprint}` : ""
          }`,
          x: 45,
          y: 0,
          width: 128,
          height: 40,
          textAlign: "left" as const,
        },
      ],
      ports: [
        {
          id: `${instance_ref}.p1`,
          properties: {
            "port.side": p1Side,
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
        {
          id: `${instance_ref}.p2`,
          properties: {
            "port.side": p2Side,
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
      ],
      properties: {
        "elk.padding": "[top=10, left=10, bottom=10, right=10]",
        "elk.portConstraints": "FIXED_SIDE",
        "elk.nodeSize.minimum": "(40, 40)",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeLabels.placement": "",
      },
    };
  }

  _netReferenceNode(
    ref_id: string,
    name: string,
    side: "NORTH" | "WEST" | "SOUTH" | "EAST" = "WEST",
    netReferenceType: NetReferenceType = NetReferenceType.NORMAL
  ): ElkNode {
    const sizes =
      netReferenceType === NetReferenceType.GROUND
        ? this.config.nodeSizes.ground
        : netReferenceType === NetReferenceType.VDD
        ? this.config.nodeSizes.vdd
        : this.config.nodeSizes.netReference;

    // Use the generated unique name if this is a power net
    const displayName =
      netReferenceType === NetReferenceType.VDD
        ? this.netNames.get(name) || name
        : name;

    // Calculate label dimensions
    const fontSize = 12; // Base font size
    const labelDimensions = calculateTextDimensions(displayName, fontSize);

    // For VDD and normal nets, we want the label to be visible
    // For ground symbols, we don't show a label
    const labels =
      netReferenceType === NetReferenceType.GROUND
        ? []
        : [
            {
              text: displayName,
              width:
                netReferenceType === NetReferenceType.VDD
                  ? labelDimensions.width
                  : 0,
              height:
                netReferenceType === NetReferenceType.VDD
                  ? labelDimensions.height
                  : 0,
              // Position the label above the node for VDD and opposite to the port side for normal nets
              x:
                netReferenceType === NetReferenceType.VDD
                  ? (sizes.width - labelDimensions.width) / 2 // Center horizontally
                  : side === "EAST"
                  ? -labelDimensions.width - 5 // Label on left when port is on east
                  : sizes.width + 5, // Label on right when port is on west
              y:
                netReferenceType === NetReferenceType.VDD
                  ? -labelDimensions.height - 5 // 5px above the node
                  : (sizes.height - labelDimensions.height) / 2, // Center vertically
            },
          ];

    // For VDD nodes, adjust the node height to account for the label if needed
    const nodeHeight =
      netReferenceType === NetReferenceType.VDD
        ? sizes.height + labelDimensions.height + 5 // Add label height plus padding
        : sizes.height;

    // For normal nets, adjust width to account for label if needed
    const nodeWidth =
      netReferenceType === NetReferenceType.NORMAL
        ? sizes.width + labelDimensions.width + 10 // Add label width plus padding
        : sizes.width;

    // Calculate port position - it should be centered on its side
    let portX = 0;
    let portY = nodeHeight / 2;

    switch (side) {
      case "EAST":
        portX = nodeWidth;
        break;
      case "WEST":
        portX = 0;
        break;
      case "NORTH":
        portX = nodeWidth / 2;
        portY = 0;
        break;
      case "SOUTH":
        portX = nodeWidth / 2;
        portY = nodeHeight;
        break;
    }

    return {
      id: ref_id,
      type: NodeType.NET_REFERENCE,
      width: nodeWidth,
      height: nodeHeight,
      netId: name,
      netReferenceType,
      labels,
      ports: [
        {
          id: `${ref_id}.port`,
          width: 0,
          height: 0,
          x: portX,
          y: portY,
          properties: {
            "port.alignment": "CENTER",
            "port.side": side,
          },
        },
      ],
      properties: {
        "elk.padding": "[top=0, left=0, bottom=0, right=0]",
        "elk.portConstraints": "FIXED_POS",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${nodeWidth}, ${nodeHeight})`,
        "elk.nodeLabels.placement":
          netReferenceType === NetReferenceType.VDD
            ? "OUTSIDE H_CENTER V_TOP"
            : "",
      },
    };
  }

  _moduleOrComponentNode(instance_ref: string): ElkNode {
    let instance = this.netlist.instances[instance_ref];
    if (!instance) {
      throw new Error(`Instance ${instance_ref} not found`);
    }

    const sizes =
      instance.kind === InstanceKind.MODULE
        ? this.config.nodeSizes.module
        : this.config.nodeSizes.component;

    // Calculate main label dimensions
    const instanceName = instance_ref.split(".").pop() || "";
    const mpn = this._getAttributeValue(instance.attributes.mpn);
    const mainLabelDimensions = calculateTextDimensions(instanceName, 12);
    const refDesLabelDimensions = calculateTextDimensions(
      instance.reference_designator || "",
      12
    );
    const mpnLabelDimensions = calculateTextDimensions(mpn || "", 12);

    // Initialize minimum width and height based on label dimensions
    let minWidth = Math.max(sizes.width, mainLabelDimensions.width + 20); // Add padding
    let minHeight = Math.max(sizes.height, mainLabelDimensions.height + 20); // Add padding

    let node: ElkNode = {
      id: instance_ref,
      type: NodeType.MODULE,
      // width: minWidth,
      // height: minHeight,
      ports: [],
      labels: [
        {
          text: instanceName,
          width: mainLabelDimensions.width,
          height: mainLabelDimensions.height,
          textAlign: "left" as const,
          properties: {
            "elk.nodeLabels.placement": "OUTSIDE H_LEFT V_TOP",
          },
        },
        ...(instance.reference_designator
          ? [
              {
                text: instance.reference_designator,
                width: refDesLabelDimensions.width,
                height: refDesLabelDimensions.height,
                textAlign: "right" as const,
                properties: {
                  "elk.nodeLabels.placement": "OUTSIDE H_RIGHT V_TOP",
                },
              },
            ]
          : []),
        ...(mpn
          ? [
              {
                text: mpn,
                width: mpnLabelDimensions.width,
                height: mpnLabelDimensions.height,
                textAlign: "left" as const,
                properties: {
                  "elk.nodeLabels.placement": "OUTSIDE H_LEFT V_BOTTOM",
                },
              },
            ]
          : []),
      ],
      properties: {},
    };

    // Helper function to check if a port is connected to a ground net
    const isGroundConnected = (port_ref: string): boolean => {
      for (const [, net] of Array.from(this.nets.entries())) {
        if (!net.has(port_ref)) continue;

        // Check if this net is a ground net
        if (this._isGndNet(net)) return true;
      }
      return false;
    };

    // Add a port on this node for (a) every child of type Port, and (b) every Port of an Interface.
    for (let [child_name, child_ref] of Object.entries(instance.children)) {
      let child_instance = this.netlist.instances[child_ref];
      if (!child_instance) {
        throw new Error(`Child ${child_ref} not found`);
      }

      if (child_instance.kind === InstanceKind.PORT) {
        const port_ref = `${instance_ref}.${child_name}`;
        // For modules, skip ground-connected ports
        if (
          instance.kind === InstanceKind.MODULE &&
          isGroundConnected(port_ref)
        ) {
          continue;
        }

        // Calculate port label dimensions
        const portLabelDimensions = calculateTextDimensions(child_name, 10);

        node.ports?.push({
          id: port_ref,
          labels: [
            {
              text: child_name,
              width: portLabelDimensions.width,
              height: portLabelDimensions.height,
            },
          ],
        });

        // Update minimum width/height to accommodate port labels
        minWidth = Math.max(minWidth, portLabelDimensions.width * 2 + 60); // Extra space for ports on both sides
        minHeight = Math.max(
          minHeight,
          mainLabelDimensions.height + portLabelDimensions.height * 2 + 40
        );
      } else if (child_instance.kind === InstanceKind.INTERFACE) {
        for (let [port_name, ] of Object.entries(
          child_instance.children
        )) {
          const full_port_ref = `${instance_ref}.${child_name}.${port_name}`;
          // For modules, skip ground-connected ports
          if (
            instance.kind === InstanceKind.MODULE &&
            isGroundConnected(full_port_ref)
          ) {
            continue;
          }

          // Calculate port label dimensions for interface ports
          const portLabel = `${child_name}.${port_name}`;
          const portLabelDimensions = calculateTextDimensions(portLabel, 10);

          node.ports?.push({
            id: full_port_ref,
            labels: [
              {
                text: portLabel,
                width: portLabelDimensions.width,
                height: portLabelDimensions.height,
              },
            ],
          });

          // Update minimum width/height to accommodate interface port labels
          minWidth = Math.max(minWidth, portLabelDimensions.width * 2 + 60);
          minHeight = Math.max(
            minHeight,
            mainLabelDimensions.height + portLabelDimensions.height * 2 + 40
          );
        }
      }
    }

    // Update final node dimensions
    node.width = minWidth;
    node.height = minHeight;

    if (instance.kind === InstanceKind.COMPONENT) {
      node.type = NodeType.COMPONENT;
      node.properties = {
        ...node.properties,
        "elk.portConstraints": "FIXED_ORDER",
      };

      // Helper function for natural sort comparison
      const naturalCompare = (a: string, b: string): number => {
        const splitIntoNumbersAndStrings = (str: string) => {
          return str
            .split(/(\d+)/)
            .filter(Boolean)
            .map((part) => (/^\d+$/.test(part) ? parseInt(part, 10) : part));
        };

        const aParts = splitIntoNumbersAndStrings(a);
        const bParts = splitIntoNumbersAndStrings(b);

        for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
          if (typeof aParts[i] !== typeof bParts[i]) {
            return typeof aParts[i] === "number" ? -1 : 1;
          }
          if (aParts[i] < bParts[i]) return -1;
          if (aParts[i] > bParts[i]) return 1;
        }
        return aParts.length - bParts.length;
      };

      node.ports?.sort((a, b) => {
        // Extract the port name from the ID (everything after the last dot)
        const aName = a.id.split(".").pop() || "";
        const bName = b.id.split(".").pop() || "";
        return naturalCompare(aName, bName);
      });

      node.ports?.forEach((port, index) => {
        const totalPorts = node.ports?.length || 0;
        const halfLength = Math.floor(totalPorts / 2);
        const isFirstHalf = index < halfLength;

        port.properties = {
          ...port.properties,
          "port.side": isFirstHalf ? "WEST" : "EAST",
          "port.index": isFirstHalf
            ? `${halfLength - 1 - (index % halfLength)}`
            : `${index % halfLength}`,
        };
      });
    }

    return node;
  }

  _nodeForInstance(instance_ref: string): ElkNode | null {
    const instance = this.netlist.instances[instance_ref];
    if (!instance) {
      throw new Error(`Instance ${instance_ref} not found`);
    }

    if ([InstanceKind.MODULE, InstanceKind.COMPONENT].includes(instance.kind)) {
      // Get the type attribute value
      const typeAttr = instance.attributes.type;
      const type =
        typeof typeAttr === "string"
          ? typeAttr
          : typeAttr?.String || // Handle AttributeValue::String
            (typeAttr?.Boolean !== undefined
              ? String(typeAttr.Boolean) // Handle AttributeValue::Boolean
              : typeAttr?.Number !== undefined
              ? String(typeAttr.Number) // Handle AttributeValue::Number
              : null); // Handle other cases

      if (type === "resistor") {
        return this._resistorNode(instance_ref);
      } else if (type === "capacitor") {
        return this._capacitorNode(instance_ref);
      } else if (type === "inductor") {
        return this._inductorNode(instance_ref);
      } else {
        return this._moduleOrComponentNode(instance_ref);
      }
    }

    return null;
  }

  _metaNode(
    nodes: ElkNode[],
    edges: ElkEdge[],
    exposedPortIds: Set<string>
  ): ElkNode {
    // Rewrite ports on `nodes` and `edges` that are in `exposedPortIds`
    let newNodes = nodes.map((node) => {
      return {
        ...node,
        ports: node.ports?.map((port) => {
          return {
            ...port,
            id: exposedPortIds.has(port.id) ? port.id + "_internal" : port.id,
          };
        }),
      };
    });

    let newEdges = edges.map((edge) => {
      return {
        ...edge,
        sources: edge.sources.map((source) =>
          exposedPortIds.has(source) ? source + "_internal" : source
        ),
        targets: edge.targets.map((target) =>
          exposedPortIds.has(target) ? target + "_internal" : target
        ),
      };
    });

    // Return node with updated ports
    return {
      id: `${nodes.map((node) => node.id).join("_")}_meta`,
      type: NodeType.META,
      children: newNodes,
      edges: newEdges,
      ports: Array.from(exposedPortIds).map((port) => ({
        id: port,
        properties: {
          fromPortId: `${port}_internal`,
          fromNodeId:
            nodes.find((node) => node.ports?.some((p) => p.id === port))?.id ??
            "",
        },
      })),
      properties: {
        "elk.padding": "[top=0, left=0, bottom=0, right=0]",
        "elk.direction": "DOWN",
        "elk.layered.spacing.nodeNodeBetweenLayers": "5",
        "elk.nodeSize.minimum": "(0, 0)",
      },
    };
  }

  _moveMetaNodePorts(node: ElkNode): ElkNode {
    if (node.type !== NodeType.META) {
      return node;
    }

    const children = node.children || [];
    node.ports = node.ports || [];

    // For each port in the meta node
    for (const metaPort of node.ports) {
      // Find the internal port this meta port should connect to
      const internalPortId = metaPort.properties?.fromPortId;
      if (!internalPortId) continue;

      // Find the child node that has this internal port
      for (const child of children) {
        const childPorts = child.ports || [];
        const internalPort = childPorts.find(
          (port) => port.id === internalPortId
        );

        if (internalPort) {
          // Copy the position from the internal port, adjusting for the child's position
          const childX = child.x || 0;
          const childY = child.y || 0;
          const portX = (internalPort.x || 0) + childX;
          const portY = (internalPort.y || 0) + childY;

          // Determine which edge of the meta node this port should be on
          const metaWidth = node.width || 0;
          const metaHeight = node.height || 0;

          const distToLeft = portX;
          const distToRight = metaWidth - portX;
          const distToTop = portY;
          const distToBottom = metaHeight - portY;

          const minDist = Math.min(
            distToLeft,
            distToRight,
            distToTop,
            distToBottom
          );

          let side: "WEST" | "EAST" | "NORTH" | "SOUTH";
          let x: number;
          let y: number;

          if (minDist === distToLeft) {
            side = "WEST";
            x = 0;
            y = portY;
          } else if (minDist === distToRight) {
            side = "EAST";
            x = metaWidth;
            y = portY;
          } else if (minDist === distToTop) {
            side = "NORTH";
            x = portX;
            y = 0;
          } else {
            side = "SOUTH";
            x = portX;
            y = metaHeight;
          }

          // Update the meta port properties
          metaPort.x = x;
          metaPort.y = y;
          metaPort.properties = {
            ...metaPort.properties,
            "port.side": side,
            "port.index": `${
              side === "WEST" || side === "EAST"
                ? y / metaHeight
                : x / metaWidth
            }`,
            "port.alignment": "CENTER",
          };

          break; // Found the matching port, no need to check other children
        }
      }
    }

    node.properties = {
      ...node.properties,
      "elk.portConstraints": "FIXED_POS",
    };

    return node;
  }

  _collectComponentsFromModule(instance_ref: string): ElkNode[] {
    const instance = this.netlist.instances[instance_ref];
    if (!instance) {
      return [];
    }

    let components: ElkNode[] = [];

    // Process all children
    for (const [, child_ref] of Object.entries(instance.children)) {
      const child_instance = this.netlist.instances[child_ref];
      if (!child_instance) continue;

      if (child_instance.kind === InstanceKind.COMPONENT) {
        const node = this._nodeForInstance(child_ref);
        if (node) components.push(node);
      } else if (child_instance.kind === InstanceKind.MODULE) {
        // Recursively collect components from submodules
        components = components.concat(
          this._collectComponentsFromModule(child_ref)
        );
      }
    }

    return components;
  }

  _getAllNodes(
    node: ElkNode | ElkGraph | { id: string; children?: ElkNode[] }
  ): ElkNode[] {
    const nodes: ElkNode[] = [];

    const children = node.children || [];

    for (const child of children) {
      nodes.push(child);

      // Recursively get nodes from children
      if (child.children) {
        nodes.push(...this._getAllNodes(child));
      }
    }

    return nodes;
  }

  _cleanupGraph(graph: ElkGraph): ElkGraph {
    // First, remove any self-edges (edges that connect a port to itself)
    graph.edges = graph.edges.filter((edge) => {
      return !(
        edge.sources.length === 1 &&
        edge.targets.length === 1 &&
        edge.sources[0] === edge.targets[0]
      );
    });

    // Next, for each module, remove ports that have no connections
    const connectedPorts = new Set<string>();

    // Collect all ports that are connected to any edge
    for (const edge of graph.edges) {
      edge.sources.forEach((port) => connectedPorts.add(port));
      edge.targets.forEach((port) => connectedPorts.add(port));
    }

    // For each module node, remove unconnected ports
    graph.children = graph.children.map((node) => {
      if (node.type !== NodeType.MODULE) {
        return node;
      }

      // Filter out ports that aren't in connectedPorts
      node.ports = node.ports?.filter((port) => connectedPorts.has(port.id));
      return node;
    });

    // For each edge that connects a passive component to a module/component,
    // set the direction based on the port side of the module/component
    graph.edges = graph.edges.map((edge) => {
      // Find the nodes at each end of the edge
      const sourceNode = graph.children.find(
        (node) => node.id === edge.sourceComponentRef
      );
      const targetNode = graph.children.find(
        (node) => node.id === edge.targetComponentRef
      );

      if (!sourceNode || !targetNode) return edge;

      // Helper function to determine if a node is passive
      const isPassive = (node: ElkNode) => {
        return [
          NodeType.RESISTOR,
          NodeType.CAPACITOR,
          NodeType.INDUCTOR,
          NodeType.NET_REFERENCE,
        ].includes(node.type);
      };

      // Helper function to determine if a node is a module or component
      const isModuleOrComponent = (node: ElkNode) => {
        return [NodeType.MODULE, NodeType.COMPONENT].includes(node.type);
      };

      // Helper function to get port side
      const getPortSide = (
        node: ElkNode,
        portId: string
      ): string | undefined => {
        const port = node.ports?.find((p) => p.id === portId);
        return port?.properties?.["port.side"];
      };

      // Only process if we have one passive and one module/component
      if (isPassive(sourceNode) && isModuleOrComponent(targetNode)) {
        // Get the port side on the module/component
        const targetPortSide = getPortSide(targetNode, edge.targets[0]);

        // If the target port is on the west side, swap source and target
        if (targetPortSide === "WEST") {
          return {
            ...edge,
            sources: edge.targets,
            targets: edge.sources,
            sourceComponentRef: edge.targetComponentRef,
            targetComponentRef: edge.sourceComponentRef,
          };
        }
      } else if (isModuleOrComponent(sourceNode) && isPassive(targetNode)) {
        // Get the port side on the module/component
        const sourcePortSide = getPortSide(sourceNode, edge.sources[0]);

        // If the source port is on the east side, swap source and target
        if (sourcePortSide === "EAST") {
          return {
            ...edge,
            sources: edge.targets,
            targets: edge.sources,
            sourceComponentRef: edge.targetComponentRef,
            targetComponentRef: edge.sourceComponentRef,
          };
        }
      }

      return edge;
    });

    // Create a map to track net reference connections
    const netRefConnections = new Map<
      string,
      { node: ElkNode; edges: ElkEdge[] }
    >();

    // Collect information about net reference connections
    for (const edge of graph.edges) {
      const sourceNode = graph.children.find(
        (node) => node.id === edge.sourceComponentRef
      );
      const targetNode = graph.children.find(
        (node) => node.id === edge.targetComponentRef
      );

      if (!sourceNode || !targetNode) continue;

      // If either node is a net reference, track its connections
      if (sourceNode.type === NodeType.NET_REFERENCE) {
        if (!netRefConnections.has(sourceNode.id)) {
          netRefConnections.set(sourceNode.id, { node: sourceNode, edges: [] });
        }
        netRefConnections.get(sourceNode.id)!.edges.push(edge);
      }
      if (targetNode.type === NodeType.NET_REFERENCE) {
        if (!netRefConnections.has(targetNode.id)) {
          netRefConnections.set(targetNode.id, { node: targetNode, edges: [] });
        }
        netRefConnections.get(targetNode.id)!.edges.push(edge);
      }
    }

    // Process each net reference
    Array.from(netRefConnections.entries()).forEach(
      ([netRefId, { node: netRefNode, edges }]) => {
        // Skip if this is a ground or VDD net reference
        if (
          netRefNode.netReferenceType === NetReferenceType.GROUND ||
          netRefNode.netReferenceType === NetReferenceType.VDD
        ) {
          return;
        }

        // Check all connected ports
        let allWest = true;
        let hasConnections = false;

        for (const edge of edges) {
          const otherNodeId =
            edge.sourceComponentRef === netRefId
              ? edge.targetComponentRef
              : edge.sourceComponentRef;
          const otherNode = graph.children.find(
            (node) => node.id === otherNodeId
          );

          if (
            !otherNode ||
            ![NodeType.MODULE, NodeType.COMPONENT].includes(otherNode.type)
          ) {
            continue;
          }

          hasConnections = true;
          const portId =
            edge.sourceComponentRef === netRefId
              ? edge.targets[0]
              : edge.sources[0];
          const portSide = otherNode.ports?.find((p) => p.id === portId)
            ?.properties?.["port.side"];

          if (portSide !== "WEST") {
            allWest = false;
            break;
          }
        }

        // If all connected ports are on the WEST side, update the net reference port to be on the EAST side
        if (
          hasConnections &&
          allWest &&
          netRefNode.ports &&
          netRefNode.ports.length > 0
        ) {
          netRefNode.ports[0].properties = {
            ...netRefNode.ports[0].properties,
            "port.side": "EAST",
          };
        }
      }
    );

    return graph;
  }

  _graphForInstance(instance_ref: string): ElkGraph {
    const instance = this.netlist.instances[instance_ref];
    if (!instance) {
      // Find all instances that are in this file
      const instances = Object.keys(this.netlist.instances).filter(
        (sub_instance_ref) => {
          const [filename, path] = sub_instance_ref.split(":");
          return filename === instance_ref.split(":")[0] && !path.includes(".");
        }
      );

      return {
        id: instance_ref,
        children: instances
          .map((instance_ref) => this._nodeForInstance(instance_ref))
          .filter((node) => node !== null) as ElkNode[],
        edges: [],
      };
    }

    // If explodeModules is true and this is a module, collect all components recursively
    if (
      this.config.layout.explodeModules &&
      instance.kind === InstanceKind.MODULE
    ) {
      const nodes = this._collectComponentsFromModule(instance_ref);
      let graph: ElkGraph = {
        id: instance_ref,
        children: nodes,
        edges: [],
      };

      graph = this._addConnectivity(graph);
      graph = this._cleanupGraph(graph);
      graph = this._createLayoutMetaNodes(graph);
      return graph;
    }

    // Create all nodes.
    const nodes: ElkNode[] = Object.values(instance.children)
      .map((child_ref) => this._nodeForInstance(child_ref))
      .filter((node) => node !== null) as ElkNode[];

    // Create edges.
    let graph: ElkGraph = {
      id: instance_ref,
      children: nodes,
      edges: [],
    };

    graph = this._addConnectivity(graph);
    graph = this._cleanupGraph(graph);
    graph = this._createLayoutMetaNodes(graph);

    return graph;
  }

  _addConnectivity(graph: ElkGraph): ElkGraph {
    // For each net in the netlist:
    //  - We will build a set `S` of ports in this graph that are in this net.
    //  - For each node in the graph:
    //    - If there is a port on the node that is in `net`, add it to `S`.
    //    - If there is a connection within `net` to something INSIDE of `node`
    //      but that is not already a port on `node`, add a port to `node` for
    //      it, and add it to `S`. Do this ONLY if `node` is of type MODULE.
    //  - If `|S| >= 1` AND there is a port in `net` that is to something
    //    OUTSIDE of the current graph, add a NetReference node to graph and
    //    connect it to the net.
    //  - Build edges to connect everything in `S` together with edges.

    // For each net in the netlist, process its connectivity
    for (const [netName, net] of Array.from(this.nets.entries())) {
      // Set of ports in this graph that are in this net
      const portsInNetToInstanceRef = new Map<string, string>();

      // Check for connections outside the graph
      const outsideConnections = new Set<string>();
      for (const portRef of Array.from(net)) {
        const isInGraph = portRef.startsWith(graph.id + ".");
        if (!isInGraph) {
          outsideConnections.add(portRef);
        }
      }

      const isGndNet = this._isGndNet(net);
      const isPowerNet = this._isPowerNet(net);

      // For each node in the graph
      for (const node of this._getAllNodes(graph)) {
        let foundConnectionInNode = false;

        // Check if any of the node's ports are in this net
        const nodePorts = node.ports || [];
        for (const port of nodePorts) {
          if (net.has(port.id)) {
            foundConnectionInNode = true;
            portsInNetToInstanceRef.set(port.id, node.id);
            port.netId = netName;
          }
        }

        // If this is a MODULE, check for internal connections that need new ports
        if (
          node.type === NodeType.MODULE &&
          !foundConnectionInNode &&
          outsideConnections.size >= 1
        ) {
          let matchingInternalPorts = [];
          for (const portRef of Array.from(net)) {
            // Check if this port reference belongs inside this node
            if (portRef.startsWith(node.id + ".")) {
              matchingInternalPorts.push(portRef);
            }
          }

          matchingInternalPorts.sort((a, b) => {
            return a.split(".").length - b.split(".").length;
          });

          if (matchingInternalPorts.length > 0 && !isGndNet) {
            portsInNetToInstanceRef.set(matchingInternalPorts[0], node.id);
            node.ports?.push({
              id: matchingInternalPorts[0],
              labels: [
                { text: matchingInternalPorts[0].replace(node.id + ".", "") },
              ],
            });
          }
        }
      }

      // Add a net reference if we need it.
      if (
        portsInNetToInstanceRef.size >= 1 &&
        outsideConnections.size >= 1 &&
        !isGndNet &&
        !isPowerNet
      ) {
        const netRefId = `${netName}_ref`;
        const netRefNode = this._netReferenceNode(netRefId, netName);
        graph.children.push(netRefNode);
        portsInNetToInstanceRef.set(netRefNode.ports![0].id, netRefId);
      }

      // Create edges to connect everything in portsInNetToInstanceRef
      const portsList = Array.from(portsInNetToInstanceRef.entries());
      portsList.sort((a, b) => a[0].localeCompare(b[0]));

      const portToComponentType = (port: string) => {
        const instanceRef = portsInNetToInstanceRef.get(port);
        const node = this._getAllNodes(graph).find(
          (node) => node.id === instanceRef
        );
        return node?.type;
      };

      const portsOfType = (types: NodeType[]) => {
        return portsList.filter(([port, _instanceRef]) => {
          let componentType = portToComponentType(port);
          if (!componentType) {
            return false;
          }

          return types.includes(componentType);
        });
      };

      const passivePorts = portsOfType([
        NodeType.RESISTOR,
        NodeType.CAPACITOR,
        NodeType.INDUCTOR,
      ]);

      const netReferencePorts = portsOfType([NodeType.NET_REFERENCE]);

      const modulePorts = portsOfType([NodeType.COMPONENT, NodeType.MODULE]);

      if (isGndNet) {
        // Group ports by their instance reference
        const instanceToPorts = new Map<string, string[]>();
        for (const [port, instanceRef] of portsList) {
          if (!instanceToPorts.has(instanceRef)) {
            instanceToPorts.set(instanceRef, []);
          }
          instanceToPorts.get(instanceRef)!.push(port);
        }

        // Create one GND reference per instance
        for (const [instanceRef, ports] of Array.from(
          instanceToPorts.entries()
        )) {
          const node = graph.children.find((n) => n.id === instanceRef);
          if (!node) continue;

          const netRefId = `${netName}_gnd_${instanceRef.replace(/\./g, "_")}`;
          const netRefNode = this._netReferenceNode(
            netRefId,
            netName,
            "NORTH",
            NetReferenceType.GROUND
          );
          netRefNode.netId = netName;

          // For modules, connect all the ports to the net reference node.
          graph.children.push(netRefNode);
          for (const port of ports) {
            graph.edges.push({
              id: `${port}-${netRefId}`,
              sources: [port],
              targets: [netRefNode.ports![0].id],
              sourceComponentRef: instanceRef,
              targetComponentRef: netRefId,
              netId: netName,
            });
          }
        }
      } else if (isPowerNet) {
        // Group ports by their instance reference
        const instanceToPorts = new Map<string, string[]>();
        for (const [port, instanceRef] of portsList) {
          if (!instanceToPorts.has(instanceRef)) {
            instanceToPorts.set(instanceRef, []);
          }
          instanceToPorts.get(instanceRef)!.push(port);
        }

        // Create one GND reference per instance
        for (const [instanceRef, ports] of Array.from(
          instanceToPorts.entries()
        )) {
          const node = graph.children.find((n) => n.id === instanceRef);
          if (!node) continue;

          const netRefId = `${netName}_gnd_${instanceRef.replace(/\./g, "_")}`;
          const netRefNode = this._netReferenceNode(
            netRefId,
            netName,
            "SOUTH",
            NetReferenceType.VDD
          );
          netRefNode.netId = netName;

          // For modules, connect all the ports to the net reference node.
          graph.children.push(netRefNode);
          for (const port of ports) {
            graph.edges.push({
              id: `${port}-${netRefId}`,
              sources: [port],
              targets: [netRefNode.ports![0].id],
              sourceComponentRef: instanceRef,
              targetComponentRef: netRefId,
              netId: netName,
            });
          }
        }
      } else {
        // First, daisy chain all of the passive ports together.
        for (let i = 0; i < passivePorts.length - 1; i++) {
          const sourcePort = passivePorts[i][0];
          const targetPort = passivePorts[i + 1][0];

          const sourcePortInstanceRef = passivePorts[i][1];
          const targetPortInstanceRef = passivePorts[i + 1][1];

          graph.edges.push({
            id: `${sourcePort}-${targetPort}`,
            sources: [sourcePort],
            targets: [targetPort],
            sourceComponentRef: sourcePortInstanceRef,
            targetComponentRef: targetPortInstanceRef,
            netId: netName,
            properties: {
              "elk.layered.priority.direction": "10",
              "elk.layered.priority.shortness": "10",
            },
          });
        }

        // Next, connect the first passive port (or if we don't have, to a module
        // port) to all of the net reference ports.
        const netReferenceConnectorPort =
          passivePorts.length > 0
            ? passivePorts[0]
            : modulePorts[modulePorts.length - 1];

        for (const netReferencePort of netReferencePorts) {
          const sourcePort = netReferenceConnectorPort[0];
          const targetPort = netReferencePort[0];

          const sourcePortInstanceRef = netReferenceConnectorPort[1];
          const targetPortInstanceRef = netReferencePort[1];

          graph.edges.push({
            id: `${sourcePort}-${targetPort}`,
            sources: [sourcePort],
            targets: [targetPort],
            sourceComponentRef: sourcePortInstanceRef,
            targetComponentRef: targetPortInstanceRef,
            netId: netName,
          });
        }

        // And finally, connect all of the module ports to the first passive port
        // (or else to the last module port).
        const moduleConnectorPort =
          passivePorts.length > 0
            ? passivePorts[0]
            : modulePorts[modulePorts.length - 1];

        for (const modulePort of modulePorts) {
          const sourcePort = moduleConnectorPort[0];
          const targetPort = modulePort[0];

          const sourcePortInstanceRef = moduleConnectorPort[1];
          const targetPortInstanceRef = modulePort[1];

          graph.edges.push({
            id: `${sourcePort}-${targetPort}`,
            sources: [sourcePort],
            targets: [targetPort],
            sourceComponentRef: sourcePortInstanceRef,
            targetComponentRef: targetPortInstanceRef,
            netId: netName,
            properties: {
              "elk.layered.priority.direction": "10",
              "elk.layered.priority.shortness": "10",
            },
          });
        }
      }
    }

    return graph;
  }

  _createLayoutMetaNodes(graph: ElkGraph): ElkGraph {
    let edgeIdsInMetaNodes: Set<string> = new Set();
    const processedNodes = new Set<string>();
    const newChildren: ElkNode[] = [];
    const newEdges: ElkEdge[] = [];

    // Keep track of which meta nodes contain which passive components
    const passiveToMetaNode = new Map<string, string>();

    // First pass: Process all passive nodes and their connected net references
    for (const node of graph.children) {
      // Skip if not a passive component or already processed
      if (
        ![NodeType.RESISTOR, NodeType.CAPACITOR, NodeType.INDUCTOR].includes(
          node.type
        ) ||
        processedNodes.has(node.id)
      ) {
        continue;
      }

      // Find all edges connected to this passive node
      const connectedEdges = graph.edges.filter(
        (e) =>
          e.sourceComponentRef === node.id || e.targetComponentRef === node.id
      );

      // Find all net references connected to this passive node
      const connectedRefs = new Set<string>();
      for (const edge of connectedEdges) {
        const otherNodeId =
          edge.sourceComponentRef === node.id
            ? edge.targetComponentRef
            : edge.sourceComponentRef;
        const otherNode = graph.children.find((n) => n.id === otherNodeId);

        if (
          otherNode?.type === NodeType.NET_REFERENCE &&
          [NetReferenceType.GROUND, NetReferenceType.VDD].includes(
            otherNode.netReferenceType!
          )
        ) {
          connectedRefs.add(otherNodeId);
        }
      }

      // If we found connected net references, create a meta node
      if (connectedRefs.size > 0) {
        const refNodes = Array.from(connectedRefs).map(
          (refId) => graph.children.find((n) => n.id === refId)!
        );

        // Find all ports that need to be exposed (those with external connections)
        const exposedPorts = new Set<string>();
        for (const edge of graph.edges) {
          // If edge connects to our passive node but other end is not in our meta node
          if (
            edge.sourceComponentRef === node.id &&
            !connectedRefs.has(edge.targetComponentRef)
          ) {
            edge.sources.forEach((port) => {
              if (port.startsWith(node.id)) {
                exposedPorts.add(port);
              }
            });
          }
          if (
            edge.targetComponentRef === node.id &&
            !connectedRefs.has(edge.sourceComponentRef)
          ) {
            edge.targets.forEach((port) => {
              if (port.startsWith(node.id)) {
                exposedPorts.add(port);
              }
            });
          }
        }

        // Create meta node containing the passive and its net references
        const metaNodeId = `${node.id}_with_refs`;
        const metaNodeEdges = connectedEdges.filter(
          (e) =>
            (e.sourceComponentRef === node.id ||
              connectedRefs.has(e.sourceComponentRef)) &&
            (e.targetComponentRef === node.id ||
              connectedRefs.has(e.targetComponentRef))
        );

        for (const edge of metaNodeEdges) {
          edgeIdsInMetaNodes.add(edge.id);
        }

        const metaNode = this._metaNode(
          [node, ...refNodes],
          metaNodeEdges,
          exposedPorts
        );

        // Keep track of which meta node contains this passive component
        passiveToMetaNode.set(node.id, metaNodeId);

        // Mark these nodes as processed
        processedNodes.add(node.id);
        connectedRefs.forEach((refId) => processedNodes.add(refId));

        // Add the meta node to our new children
        newChildren.push(metaNode);
      }
    }

    // Add all unprocessed nodes
    for (const node of graph.children) {
      if (!processedNodes.has(node.id)) {
        newChildren.push(node);
      }
    }

    // Process all edges
    for (const edge of graph.edges) {
      if (edgeIdsInMetaNodes.has(edge.id)) {
        continue;
      }

      // If neither endpoint is in a meta node, keep the edge as is
      if (
        !processedNodes.has(edge.sourceComponentRef) &&
        !processedNodes.has(edge.targetComponentRef)
      ) {
        newEdges.push(edge);
        continue;
      }

      // If one endpoint is in a meta node, we need to update the edge
      const sourceMetaId = passiveToMetaNode.get(edge.sourceComponentRef);
      const targetMetaId = passiveToMetaNode.get(edge.targetComponentRef);

      // Create a new edge with updated endpoints if needed
      const newEdge: ElkEdge = {
        ...edge,
        sourceComponentRef: sourceMetaId || edge.sourceComponentRef,
        targetComponentRef: targetMetaId || edge.targetComponentRef,
      };

      newEdges.push(newEdge);
    }

    return {
      ...graph,
      children: newChildren,
      edges: newEdges,
    };
  }

  roots(): string[] {
    return Object.keys(this.netlist.instances).filter(
      (instance_ref) =>
        this.netlist.instances[instance_ref].kind === InstanceKind.MODULE
    );
  }

  _flattenGraph(graph: ElkGraph): ElkGraph {
    const flattenedNodes: ElkNode[] = [];
    const flattenedEdges: ElkEdge[] = [];

    const portIdToNodeMap = new Map<string, string>();

    function flattenNode(node: ElkNode, parentX = 0, parentY = 0) {
      // If this is a meta node, we need to restore the original port IDs
      if (node.type === NodeType.META) {
        // Build a map of internal port IDs to their original IDs
        const portIdMap = new Map<string, string>();
        for (const metaPort of node.ports || []) {
          const internalPortId = metaPort.properties?.fromPortId;
          if (internalPortId) {
            portIdMap.set(internalPortId, metaPort.id);
          }

          const nodeId = metaPort.properties?.fromNodeId;
          if (nodeId) {
            portIdToNodeMap.set(metaPort.id, nodeId);
          }
        }

        // Process children with restored port IDs
        if (node.children) {
          for (const child of node.children) {
            // Create a copy of the child with adjusted coordinates
            const flatChild: ElkNode = {
              ...child,
              children: undefined,
              edges: undefined,
              x: (child.x || 0) + (node.x || 0) + parentX,
              y: (child.y || 0) + (node.y || 0) + parentY,
              // Restore original port IDs
              ports: child.ports?.map((port) => ({
                ...port,
                id: portIdMap.get(port.id) || port.id,
              })),
            };
            flattenedNodes.push(flatChild);
          }
        }

        // Process edges with restored port IDs
        if (node.edges) {
          for (const edge of node.edges) {
            const flatEdge: ElkEdge = {
              ...edge,
              // Restore original port IDs in sources and targets
              sources: edge.sources.map(
                (source) => portIdMap.get(source) || source
              ),
              targets: edge.targets.map(
                (target) => portIdMap.get(target) || target
              ),
              // Adjust coordinates
              sections: edge.sections?.map((section) => ({
                ...section,
                startPoint: {
                  x: section.startPoint.x + (node.x || 0) + parentX,
                  y: section.startPoint.y + (node.y || 0) + parentY,
                },
                endPoint: {
                  x: section.endPoint.x + (node.x || 0) + parentX,
                  y: section.endPoint.y + (node.y || 0) + parentY,
                },
                bendPoints: section.bendPoints?.map((point) => ({
                  x: point.x + (node.x || 0) + parentX,
                  y: point.y + (node.y || 0) + parentY,
                })),
              })),
              junctionPoints: edge.junctionPoints?.map((point) => ({
                x: point.x + (node.x || 0) + parentX,
                y: point.y + (node.y || 0) + parentY,
              })),
            };
            flattenedEdges.push(flatEdge);
          }
        }
      } else {
        // For non-meta nodes, just flatten normally
        if (!node.children || node.children.length === 0) {
          const flatNode: ElkNode = {
            ...node,
            children: undefined,
            edges: undefined,
            x: (node.x || 0) + parentX,
            y: (node.y || 0) + parentY,
          };
          flattenedNodes.push(flatNode);
        }

        // Process nested nodes
        if (node.children) {
          for (const child of node.children) {
            flattenNode(
              child,
              (node.x || 0) + parentX,
              (node.y || 0) + parentY
            );
          }
        }

        // Process nested edges
        if (node.edges) {
          for (const edge of node.edges) {
            const flatEdge: ElkEdge = {
              ...edge,
              sections: edge.sections?.map((section) => ({
                ...section,
                startPoint: {
                  x: section.startPoint.x + (node.x || 0) + parentX,
                  y: section.startPoint.y + (node.y || 0) + parentY,
                },
                endPoint: {
                  x: section.endPoint.x + (node.x || 0) + parentX,
                  y: section.endPoint.y + (node.y || 0) + parentY,
                },
                bendPoints: section.bendPoints?.map((point) => ({
                  x: point.x + (node.x || 0) + parentX,
                  y: point.y + (node.y || 0) + parentY,
                })),
              })),
              junctionPoints: edge.junctionPoints?.map((point) => ({
                x: point.x + (node.x || 0) + parentX,
                y: point.y + (node.y || 0) + parentY,
              })),
            };
            flattenedEdges.push(flatEdge);
          }
        }
      }
    }

    // Process top-level nodes
    for (const node of graph.children) {
      flattenNode(node);
    }

    // Process top-level edges
    for (const edge of graph.edges) {
      const flatEdge: ElkEdge = {
        ...edge,
        sourceComponentRef:
          portIdToNodeMap.get(edge.sources[0]) || edge.sourceComponentRef,
        targetComponentRef:
          portIdToNodeMap.get(edge.targets[0]) || edge.targetComponentRef,
        sections: edge.sections?.map((section) => ({
          ...section,
          startPoint: { ...section.startPoint },
          endPoint: { ...section.endPoint },
          bendPoints: section.bendPoints?.map((point) => ({ ...point })),
        })),
        junctionPoints: edge.junctionPoints?.map((point) => ({ ...point })),
      };
      flattenedEdges.push(flatEdge);
    }

    return {
      id: graph.id,
      children: flattenedNodes,
      edges: flattenedEdges,
    };
  }

  _computeNodeDimensionsAfterPortAssignment(node: ElkNode): ElkNode {
    if (node.type !== NodeType.MODULE && node.type !== NodeType.COMPONENT) {
      return node;
    }

    // Get the main label dimensions
    const mainLabelHeight = node.labels?.[0]?.height || 0;
    const mainLabelWidth = node.labels?.[0]?.width || 0;

    // Group ports by side
    const portsBySide = {
      WEST: [] as ElkPort[],
      EAST: [] as ElkPort[],
      NORTH: [] as ElkPort[],
      SOUTH: [] as ElkPort[],
    };

    // Collect ports by their assigned sides
    for (const port of node.ports || []) {
      const side = port.properties?.["port.side"];
      if (side && side in portsBySide) {
        portsBySide[side as keyof typeof portsBySide].push(port);
      }
    }

    // Calculate required width and height based on port labels
    let requiredWidth = mainLabelWidth;
    let requiredHeight = mainLabelHeight;

    // Helper to get max label width for a set of ports
    const getMaxPortLabelWidth = (ports: ElkPort[]): number => {
      return Math.max(0, ...ports.map((port) => port.labels?.[0]?.width || 0));
    };

    // Helper to get total height needed for a set of ports
    const getTotalPortHeight = (ports: ElkPort[]): number => {
      return ports.reduce(
        (sum, port) => sum + (port.labels?.[0]?.height || 0) + 10,
        0
      ); // 10px spacing between ports
    };

    // Calculate width needed for left and right ports
    const leftPortsWidth = getMaxPortLabelWidth(portsBySide.WEST);
    const rightPortsWidth = getMaxPortLabelWidth(portsBySide.EAST);
    requiredWidth = Math.max(
      requiredWidth,
      leftPortsWidth + rightPortsWidth + 80 // Add padding and space between sides
    );

    // Calculate height needed for top and bottom ports
    const topPortsHeight = getTotalPortHeight(portsBySide.NORTH);
    const bottomPortsHeight = getTotalPortHeight(portsBySide.SOUTH);

    // Calculate height needed for left and right side ports
    const leftPortsHeight = getTotalPortHeight(portsBySide.WEST);
    const rightPortsHeight = getTotalPortHeight(portsBySide.EAST);

    // Take the maximum height needed
    requiredHeight = Math.max(
      requiredHeight + 40, // Add padding for the main label
      topPortsHeight + bottomPortsHeight + 60, // Add padding between top and bottom
      Math.max(leftPortsHeight, rightPortsHeight) + 40 // Height for side ports
    );

    // Update node dimensions
    return {
      ...node,
      width: Math.max(requiredWidth, node.width || 0),
      height: Math.max(requiredHeight, node.height || 0),
      properties: {
        ...node.properties,
        "elk.nodeSize.minimum": `(${requiredWidth}, ${requiredHeight})`,
      },
    };
  }

  async render(instance_ref: string): Promise<ElkGraph> {
    const graph = this._graphForInstance(instance_ref);

    const layoutOptions = {
      "elk.algorithm": "layered",
      "elk.direction": this.config.layout.direction,
      "elk.spacing.nodeNode": `${this.config.layout.spacing}`,
      "elk.layered.spacing.nodeNodeBetweenLayers": `${this.config.layout.spacing}`,
      "elk.padding": `[top=${this.config.layout.padding}, left=${this.config.layout.padding}, bottom=${this.config.layout.padding}, right=${this.config.layout.padding}]`,
      "elk.nodeSize.constraints": "NODE_LABELS PORTS PORT_LABELS MINIMUM_SIZE",
      "elk.partitioning.activate": "true",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.portLabels.placement": "INSIDE NEXT_TO_PORT_IF_POSSIBLE",
    };

    // First pass - run layout with free port constraints
    console.log("First pass layout - running with free port constraints");
    const firstLayoutOptions = {
      ...layoutOptions,
      "elk.portConstraints": "FREE",
    };
    console.log(
      JSON.stringify({ ...graph, layoutOptions: firstLayoutOptions }, null, 2)
    );
    const firstPassLayout = await this.elk.layout(graph, {
      layoutOptions: firstLayoutOptions,
    });
    console.log("Output of first pass layout:");
    console.log(JSON.stringify(firstPassLayout, null, 2));

    // Analyze port positions and fix their sides
    const allNodes = this._getAllNodes(firstPassLayout);
    for (const node of allNodes) {
      if (node.type === NodeType.MODULE || node.type === NodeType.COMPONENT) {
        if (!node.ports) continue;

        const nodeWidth = node.width || 0;
        const nodeHeight = node.height || 0;

        // First pass: determine initial closest sides
        const westPorts: ElkPort[] = [];
        const eastPorts: ElkPort[] = [];
        const northSouthPorts: ElkPort[] = [];

        for (const port of node.ports) {
          if (port.x === undefined || port.y === undefined) continue;

          // Calculate distances to each edge
          const distToLeft = port.x;
          const distToRight = nodeWidth - port.x;
          const distToTop = port.y;
          const distToBottom = nodeHeight - port.y;

          // Find the minimum distance and its corresponding side
          const distances = [
            { side: "WEST", dist: distToLeft },
            { side: "EAST", dist: distToRight },
            { side: "NORTH", dist: distToTop },
            { side: "SOUTH", dist: distToBottom },
          ];

          const closestEdge = distances.reduce((min, curr) =>
            curr.dist < min.dist ? curr : min
          );

          // Group ports based on their closest edge
          if (closestEdge.side === "WEST") {
            westPorts.push(port);
          } else if (closestEdge.side === "EAST") {
            eastPorts.push(port);
          } else {
            // For NORTH or SOUTH ports, we'll redistribute them
            northSouthPorts.push(port);
          }
        }

        // Redistribute NORTH/SOUTH ports to balance WEST/EAST sides
        for (const port of northSouthPorts) {
          if (port.x === undefined) continue;

          // Determine which side to assign based on current balance
          const assignToWest = westPorts.length <= eastPorts.length;

          if (assignToWest) {
            westPorts.push(port);
          } else {
            eastPorts.push(port);
          }
        }

        // Assign final sides to all ports
        for (const port of westPorts) {
          port.properties = {
            ...port.properties,
            "port.side": "WEST",
          };
        }

        for (const port of eastPorts) {
          port.properties = {
            ...port.properties,
            "port.side": "EAST",
          };
        }

        // After assigning port sides, compute final dimensions
        const updatedNode =
          this._computeNodeDimensionsAfterPortAssignment(node);
        Object.assign(node, updatedNode);
      }
    }

    for (const node of firstPassLayout.children || []) {
      this._moveMetaNodePorts(node);
    }

    // Clear junction points and sections; they will be re-computed in the second pass
    for (const edge of firstPassLayout.edges || []) {
      edge.junctionPoints = [];
      edge.sections = [];
    }

    // Second pass - run layout with fixed port sides
    console.log("Second pass layout - running with fixed port sides");
    const secondLayoutOptions = {
      ...layoutOptions,
      "elk.portConstraints": "FIXED_SIDE",
      "elk.interactive": "true",
    };
    console.log(
      JSON.stringify({ ...graph, layoutOptions: secondLayoutOptions }, null, 2)
    );
    const secondPassLayout = await this.elk.layout(
      {
        ...graph,
        children: firstPassLayout.children || [],
      },
      {
        layoutOptions: secondLayoutOptions,
      }
    );

    console.log("Output of second pass layout:");
    console.log(JSON.stringify(secondPassLayout, null, 2));

    let flattenedGraph = this._flattenGraph({
      ...secondPassLayout,
      children: secondPassLayout.children || [],
      edges: secondPassLayout.edges || [],
    });

    console.log("Output of flattened graph:");
    console.log(JSON.stringify(flattenedGraph, null, 2));

    // Flatten the graph before returning
    return flattenedGraph;
  }

  _getPowerInterfaceName(instance_ref: string): string | null {
    const instance = this.netlist.instances[instance_ref];
    if (!instance || instance.kind !== InstanceKind.INTERFACE) return null;

    // Check if this is a Power interface
    if (instance.type_ref.module_name !== "Power") return null;

    // Get the parent instance (the component that owns this interface)
    const parentRef = instance_ref.split(".").slice(0, -1).join(".");
    const parentInstance = this.netlist.instances[parentRef];
    if (!parentInstance || parentInstance.type_ref.module_name === "Capacitor")
      return null;

    return instance_ref.split(":").pop()?.split(".").pop() || null;
  }

  _generatePowerNetName(net: Set<string>): string[] {
    const powerNamesToLength: Map<string, number> = new Map();

    // Find all power interfaces connected to this net
    for (const portRef of Array.from(net)) {
      // Get the interface reference (everything up to the last dot)
      const interfaceRef = portRef.split(".").slice(0, -1).join(".");
      const powerName = this._getPowerInterfaceName(interfaceRef);
      if (powerName) {
        powerNamesToLength.set(powerName, interfaceRef.split(".").length);
      }
    }

    // Sort by length (prefer shorter names) and then alphabetically for deterministic behavior
    return Array.from(powerNamesToLength.entries())
      .sort((a, b) => {
        if (a[1] !== b[1]) return a[1] - b[1];
        return a[0].localeCompare(b[0]);
      })
      .map(([name]) => name);
  }

  _generateUniqueNetNames(): Map<string, string> {
    const netNames = new Map<string, string>();

    // Group nets by their top-level module
    const netsByModule = new Map<string, Map<string, Set<string>>>();

    for (const [netId, net] of Array.from(this.nets.entries())) {
      if (!this._isPowerNet(net)) continue;

      // Find the top-level module for this net
      let topLevelModule = "";
      for (const portRef of Array.from(net)) {
        const parts = (portRef as string).split(".");
        if (parts.length > 0) {
          // The first part is the filename, second part is the top-level module
          if (parts.length > 1) {
            topLevelModule = parts[1];
            break;
          }
        }
      }

      if (!topLevelModule) continue;

      // Initialize map for this module if it doesn't exist
      if (!netsByModule.has(topLevelModule)) {
        netsByModule.set(topLevelModule, new Map());
      }
      netsByModule.get(topLevelModule)!.set(netId, net);
    }

    // Process each module's nets separately
    for (const [, moduleNets] of Array.from(netsByModule.entries())) {
      const usedNames = new Set<string>();

      // Collect all nets and their possible names for this module
      const netsAndNames = Array.from(moduleNets.entries())
        .map(([netId, net]: [string, Set<string>]) => ({
          netId,
          possibleNames: this._generatePowerNetName(net),
        }))
        // Sort by number of name options (handle nets with fewer options first)
        .sort((a, b) => a.possibleNames.length - b.possibleNames.length);

      // Process each net within this module
      for (const { netId, possibleNames } of netsAndNames) {
        let assigned = false;

        // Try each possible name in order
        if (possibleNames.length > 0) {
          for (const name of possibleNames) {
            const fullName = `${name}`;
            if (!usedNames.has(fullName)) {
              usedNames.add(fullName);
              netNames.set(netId, fullName);
              assigned = true;
              break;
            }
          }
        }

        // If we couldn't assign any of the preferred names, use the shortest one with a prime
        if (!assigned) {
          const baseName = possibleNames.length > 0 ? possibleNames[0] : "VDD";
          let uniqueName = `${baseName}`;
          let primeCount = 0;

          while (usedNames.has(uniqueName)) {
            primeCount++;
            uniqueName = `${baseName}${"'".repeat(primeCount)}`;
          }

          usedNames.add(uniqueName);
          netNames.set(netId, uniqueName);
        }
      }
    }

    return netNames;
  }
}
