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
  isGround?: boolean; // Only used for net reference nodes
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
      width: 15,
      height: 15,
    },
    netJunction: {
      width: 10,
      height: 10,
    },
    ground: {
      width: 30,
      height: 50,
    },
  },
  layout: {
    direction: "LEFT",
    spacing: 50,
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

  constructor(netlist: Netlist, config: Partial<SchematicConfig> = {}) {
    this.netlist = netlist;
    this.elk = new ELK({
      workerFactory: function (url) {
        const { Worker } = require("elkjs/lib/elk-worker.js"); // non-minified
        return new Worker(url);
      },
    });
    this.nets = this._generateNets();
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

  _resistorNode(instance_ref: string): ElkNode {
    const instance = this.netlist.instances[instance_ref];
    const footprint =
      this._getAttributeValue(instance.attributes.package) ||
      this._getAttributeValue(instance.attributes.footprint);

    const value = this._renderValue(instance.attributes.value);
    const showValue = this.config.visual.showComponentValues && value;
    const showFootprint = this.config.visual.showFootprints && footprint;

    return {
      id: instance_ref,
      type: NodeType.RESISTOR,
      width: this.config.nodeSizes.resistor.width,
      height: this.config.nodeSizes.resistor.height,
      labels: [
        {
          text: `${showValue ? value : ""}${
            showFootprint ? `\n${footprint}` : ""
          }`,
          x: 45,
          y: 15,
          width: 128,
          height: 30,
        },
      ],
      ports: [
        {
          id: `${instance_ref}.p1`,
          properties: {
            "port.side": "NORTH",
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
        {
          id: `${instance_ref}.p2`,
          properties: {
            "port.side": "SOUTH",
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

    return {
      id: instance_ref,
      type: NodeType.CAPACITOR,
      width: this.config.nodeSizes.capacitor.width,
      height: this.config.nodeSizes.capacitor.height,
      labels: [
        {
          text: `${showValue ? value : ""}${
            showFootprint ? `\n${footprint}` : ""
          }`,
          x: 45,
          y: 10,
          width: 128,
          height: 20,
        },
      ],
      ports: [
        {
          id: `${instance_ref}.p1`,
          properties: {
            "port.side": "NORTH",
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
        {
          id: `${instance_ref}.p2`,
          properties: {
            "port.side": "SOUTH",
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

    return {
      id: instance_ref,
      type: NodeType.INDUCTOR,
      width: this.config.nodeSizes.inductor.width,
      height: this.config.nodeSizes.inductor.height,
      labels: [
        {
          text: `${showValue ? value : ""}${
            showFootprint ? `\n${footprint}` : ""
          }`,
          x: 45,
          y: 20,
          width: 128,
          height: 40,
        },
      ],
      ports: [
        {
          id: `${instance_ref}.p1`,
          properties: {
            "port.side": "NORTH",
            "port.index": "0",
            "port.anchor": "CENTER",
            "port.alignment": "CENTER",
          },
        },
        {
          id: `${instance_ref}.p2`,
          properties: {
            "port.side": "SOUTH",
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
    side: "NORTH" | "WEST" = "WEST",
    isGround: boolean = false
  ): ElkNode {
    const sizes = isGround
      ? this.config.nodeSizes.ground
      : this.config.nodeSizes.netReference;
    return {
      id: ref_id,
      type: NodeType.NET_REFERENCE,
      width: sizes.width,
      height: sizes.height,
      netId: name,
      isGround: isGround,
      labels: isGround ? [] : [{ text: name }],
      ports: [
        {
          id: `${ref_id}.port`,
          width: -1,
          height: -1,
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
        "elk.nodeSize.minimum": `(${sizes.width}, ${sizes.height})`,
        "elk.nodeLabels.placement": "",
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
    const mainLabelDimensions = calculateTextDimensions(instanceName, 12);

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
        },
      ],
      properties: {
        "elk.nodeLabels.placement": "OUTSIDE H_LEFT V_TOP",
      },
    };

    // Helper function to check if a port is connected to a ground net
    const isGroundConnected = (port_ref: string): boolean => {
      for (const [_netName, net] of Array.from(this.nets.entries())) {
        if (!net.has(port_ref)) continue;

        // Check if this net is a ground net
        const isGndNet = Array.from(net).some(
          (port) =>
            port.toLowerCase().endsWith(".gnd") &&
            !port.toLowerCase().endsWith(".power.gnd")
        );

        if (isGndNet) console.log("gnd net: ", port_ref);
        if (isGndNet) return true;
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
        for (let [port_name, _port_ref] of Object.entries(
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

      node.ports?.sort((a, b) => {
        return a.id.localeCompare(b.id);
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
        "elk.layered.spacing.nodeNodeBetweenLayers": "0",
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
    for (const [_child_name, child_ref] of Object.entries(instance.children)) {
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

      const isGndNet = Array.from(net).some((port) => {
        // This is a hack to work around capacitors exposing a `power` interface that will make it
        // look like anything connected to `p2` is a ground net. We should really come up with
        // something better here.
        return (
          port.toLowerCase().endsWith(".gnd") &&
          !port.toLowerCase().endsWith(".power.gnd")
        );
      });

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
        !isGndNet
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
            "GND",
            "NORTH",
            true
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

    // Create a map of net IDs to their edges
    const netToEdges = new Map<string, ElkEdge[]>();
    for (const edge of graph.edges) {
      if (!edge.netId) continue;
      if (!netToEdges.has(edge.netId)) {
        netToEdges.set(edge.netId, []);
      }
      netToEdges.get(edge.netId)!.push(edge);
    }

    // For each net, find passive components that are exclusively connected to net references
    const processedNodes = new Set<string>();
    const newChildren: ElkNode[] = [];
    const newEdges: ElkEdge[] = [];

    // Keep track of which meta nodes contain which passive components
    const passiveToMetaNode = new Map<string, string>();

    // Convert Map entries to array for iteration
    const netEntries = Array.from(netToEdges.entries());
    for (const netEntry of netEntries) {
      const edges = netEntry[1];
      // Get all nodes connected to this net
      const connectedNodes = new Set<string>();
      for (const edge of edges) {
        connectedNodes.add(edge.sourceComponentRef);
        connectedNodes.add(edge.targetComponentRef);
      }

      // Find passive nodes in this net
      const passiveNodes = Array.from(connectedNodes).filter((nodeId) => {
        const node = graph.children.find((n) => n.id === nodeId);
        return (
          node &&
          [NodeType.RESISTOR, NodeType.CAPACITOR, NodeType.INDUCTOR].includes(
            node.type
          )
        );
      });

      // For each passive node
      for (const passiveNodeId of passiveNodes) {
        if (processedNodes.has(passiveNodeId)) continue;

        // Find all net references exclusively connected to this passive node
        const connectedRefs = Array.from(connectedNodes).filter((nodeId) => {
          const node = graph.children.find((n) => n.id === nodeId);
          if (!node || node.type !== NodeType.NET_REFERENCE || !node.isGround)
            return false;

          // Check if this net reference is only connected to this passive node
          const refEdges = edges.filter(
            (e: ElkEdge) =>
              e.sourceComponentRef === nodeId || e.targetComponentRef === nodeId
          );
          return refEdges.every(
            (e: ElkEdge) =>
              e.sourceComponentRef === passiveNodeId ||
              e.targetComponentRef === passiveNodeId
          );
        });

        // If we found exclusive net references, create a meta node
        if (connectedRefs.length > 0) {
          const passiveNode = graph.children.find(
            (n) => n.id === passiveNodeId
          )!;
          const refNodes = connectedRefs.map(
            (refId) => graph.children.find((n) => n.id === refId)!
          );

          // Find all ports that need to be exposed (those with external connections)
          const exposedPorts = new Set<string>();
          for (const edge of graph.edges) {
            // If edge connects to our passive node but other end is not in our meta node
            if (
              edge.sourceComponentRef === passiveNodeId &&
              !connectedRefs.includes(edge.targetComponentRef)
            ) {
              // Add all ports from this edge that belong to our passive node
              edge.sources.forEach((port) => {
                if (port.startsWith(passiveNodeId)) {
                  exposedPorts.add(port);
                }
              });
            }
            if (
              edge.targetComponentRef === passiveNodeId &&
              !connectedRefs.includes(edge.sourceComponentRef)
            ) {
              edge.targets.forEach((port) => {
                if (port.startsWith(passiveNodeId)) {
                  exposedPorts.add(port);
                }
              });
            }
          }

          // Create meta node containing the passive and its net references
          const metaNodeId = `${passiveNodeId}_with_refs`;
          const metaNodeEdges = edges.filter(
            (e: ElkEdge) =>
              (e.sourceComponentRef === passiveNodeId ||
                connectedRefs.includes(e.sourceComponentRef)) &&
              (e.targetComponentRef === passiveNodeId ||
                connectedRefs.includes(e.targetComponentRef))
          );

          for (const edge of metaNodeEdges) {
            edgeIdsInMetaNodes.add(edge.id);
          }

          const metaNode = this._metaNode(
            [passiveNode, ...refNodes],
            metaNodeEdges,
            exposedPorts
          );

          // Keep track of which meta node contains this passive component
          passiveToMetaNode.set(passiveNodeId, metaNodeId);

          // Mark these nodes as processed
          processedNodes.add(passiveNodeId);
          connectedRefs.forEach((refId) => processedNodes.add(refId));

          // Add the meta node to our new children
          newChildren.push(metaNode);
        }
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
      "elk.padding": `[top=${this.config.layout.padding}, left=${this.config.layout.padding}, bottom=${this.config.layout.padding}, right=${this.config.layout.padding}]`,
      "elk.nodeSize.constraints": "NODE_LABELS PORTS PORT_LABELS MINIMUM_SIZE",
      // "elk.nodeLabels.placement": "OUTSIDE H_RIGHT V_TOP",
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

    // Clear junction points; they will be re-computed in the second pass
    for (const edge of firstPassLayout.edges || []) {
      edge.junctionPoints = [];
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
}
