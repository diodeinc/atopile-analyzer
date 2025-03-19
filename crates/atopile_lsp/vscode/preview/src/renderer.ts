import ELK from "elkjs/lib/elk-api.js";
import type { ELK as ELKType } from "elkjs/lib/elk-api";
import { InstanceKind, Netlist } from "./types/NetlistTypes";

export enum NodeType {
  MODULE = "module",
  COMPONENT = "component",
  RESISTOR = "resistor",
  CAPACITOR = "capacitor",
  NET_REFERENCE = "net_reference",
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
}

export interface ElkPort {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  labels?: ElkLabel[];
  properties?: Record<string, string>;
}

export interface ElkLabel {
  text: string;
  x?: number;
  y?: number;
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
}

export interface ElkGraph {
  id: string;
  children: ElkNode[];
  edges: ElkEdge[];
}

export class SchematicRenderer {
  netlist: Netlist;
  elk: ELKType;
  nets: Map<string, Set<string>>;

  constructor(netlist: Netlist) {
    this.netlist = netlist;
    this.elk = new ELK({
      workerFactory: function (url) {
        const { Worker } = require("elkjs/lib/elk-worker.js"); // non-minified
        return new Worker(url);
      },
    });
    this.nets = this._generateNets();
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

  _resistorNode(instance_ref: string): ElkNode {
    return {
      id: instance_ref,
      type: NodeType.RESISTOR,
      width: 40,
      height: 100,
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
        "elk.nodeSize.minimum": "(40, 100)",
      },
    };
  }

  _capacitorNode(instance_ref: string): ElkNode {
    return {
      id: instance_ref,
      type: NodeType.CAPACITOR,
      width: 40,
      height: 40,
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
      },
    };
  }

  _netReferenceNode(ref_id: string, name: string): ElkNode {
    return {
      id: ref_id,
      type: NodeType.NET_REFERENCE,
      width: 15,
      height: 15,
      netId: name,
      labels: [{ text: name }],
      ports: [
        {
          id: ref_id,
          width: -1,
          height: -1,
          properties: {
            "port.anchor": "(15, 15)",
            "port.alignment": "CENTER",
          },
        },
      ],
      properties: {
        "elk.padding": "[top=30, left=30, bottom=30, right=30]",
        "elk.portConstraints": "FIXED_POS",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": "(15, 15)",
      },
    };
  }

  _moduleOrComponentNode(instance_ref: string): ElkNode {
    let instance = this.netlist.instances[instance_ref];
    if (!instance) {
      throw new Error(`Instance ${instance_ref} not found`);
    }

    let node: ElkNode = {
      id: instance_ref,
      type: NodeType.MODULE,
      width: 256,
      height: 128,
      ports: [],
      properties: {
        "elk.padding": "[top=20, left=20, bottom=20, right=20]",
      },
      labels: [{ text: instance_ref.split(".").pop() || "" }],
    };

    // Add a port on this node for (a) every child of type Port, and (b) every Port of an Interface.
    for (let [child_name, child_ref] of Object.entries(instance.children)) {
      let child_instance = this.netlist.instances[child_ref];
      if (!child_instance) {
        throw new Error(`Child ${child_ref} not found`);
      }

      if (child_instance.kind === InstanceKind.PORT) {
        node.ports?.push({
          id: `${instance_ref}.${child_name}`,
          labels: [{ text: child_name }],
        });
      } else if (child_instance.kind === InstanceKind.INTERFACE) {
        for (let port_name of Object.keys(child_instance.children)) {
          node.ports?.push({
            id: `${instance_ref}.${child_name}.${port_name}`,
            labels: [{ text: `${child_name}.${port_name}` }],
          });
        }
      }
    }

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
      if (instance.attributes.type === "resistor") {
        return this._resistorNode(instance_ref);
      } else if (instance.attributes.type === "capacitor") {
        return this._capacitorNode(instance_ref);
      } else {
        return this._moduleOrComponentNode(instance_ref);
      }
    }

    return null;
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
      const portsInGraphToInstanceRef = new Map<string, string>();

      // Check for connections outside the graph
      const outsideConnections = new Set<string>();
      for (const portRef of Array.from(net)) {
        const isInGraph = portRef.startsWith(graph.id + ".");
        if (!isInGraph) {
          outsideConnections.add(portRef);
        }
      }

      // For each node in the graph
      for (const node of graph.children) {
        let foundConnectionInNode = false;

        // Check if any of the node's ports are in this net
        const nodePorts = node.ports || [];
        for (const port of nodePorts) {
          if (net.has(port.id)) {
            foundConnectionInNode = true;
            portsInGraphToInstanceRef.set(port.id, node.id);
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

          if (matchingInternalPorts.length > 0) {
            portsInGraphToInstanceRef.set(matchingInternalPorts[0], node.id);
            node.ports?.push({
              id: matchingInternalPorts[0],
              labels: [
                { text: matchingInternalPorts[0].replace(node.id + ".", "") },
              ],
            });
          }
        }
      }

      // If we have ports in the graph and outside connections, add a NetReference node
      if (portsInGraphToInstanceRef.size >= 1 && outsideConnections.size >= 1) {
        const netRefId = `${netName}_ref`;
        const netRefNode = this._netReferenceNode(netRefId, netName);

        graph.children.push(netRefNode);

        // Connect the net reference to one of the ports in the graph
        const firstPort = Array.from(portsInGraphToInstanceRef.keys())[0];
        const sourceComponentRef =
          graph.children.find(
            (node) =>
              firstPort.startsWith(node.id + ".") ||
              (node.ports || []).some((port) => port.id === firstPort)
          )?.id || "";

        graph.edges.push({
          id: `${netName}_ref_edge`,
          sources: [firstPort],
          targets: [netRefId],
          sourceComponentRef: sourceComponentRef,
          targetComponentRef: netRefId,
          netId: netName,
        });
      }

      // Create edges to connect everything in portsInGraph
      const portsList = Array.from(portsInGraphToInstanceRef.entries());
      portsList.sort((a, b) => {
        return a[0].localeCompare(b[0]);
      });

      for (let i = 0; i < portsList.length - 1; i++) {
        const [sourcePort, sourceInstanceRef] = portsList[i];
        const [targetPort, targetInstanceRef] = portsList[i + 1];

        graph.edges.push({
          id: `${sourcePort}-${targetPort}`,
          sources: [sourcePort],
          targets: [targetPort],
          sourceComponentRef: sourceInstanceRef,
          targetComponentRef: targetInstanceRef,
          netId: netName,
        });
      }
    }

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

    // Create all nodes.
    const nodes: ElkNode[] = Object.values(instance.children)
      .map((child_ref) => this._nodeForInstance(child_ref))
      .filter((node) => node !== null) as ElkNode[];

    // Create edges.
    let graph = {
      id: instance_ref,
      children: nodes,
      edges: [],
    };

    return this._addConnectivity(graph);
  }

  roots(): string[] {
    return Object.keys(this.netlist.instances).filter(
      (instance_ref) =>
        this.netlist.instances[instance_ref].kind === InstanceKind.MODULE
    );
  }

  async render(instance_ref: string): Promise<ElkGraph> {
    const graph = this._graphForInstance(instance_ref);

    const layoutOptions = {
      // Use a layered algorithm which is good for circuit diagrams
      "elk.algorithm": "layered",
      // Right-to-left layout for electrical schematics
      "elk.direction": "RIGHT",
      // Spacing between nodes
      // Spacing between layers
      // "elk.layered.spacing.nodeNodeBetweenLayers": "100", // Increased for more space between layers
      // Route edges orthogonally (right angles) - CRITICAL for electrical schematics
      "elk.edges.routing": "ORTHOGONAL",
      // Enable bend points so we can use them for routing
      "elk.edges.bendPoints": "TRUE",
      // Force orthogonal routing even for special cases
      "elk.layered.feedbackEdges.enableSplines": "false",
      "elk.layered.unnecessaryBendpoints": "false",
      // High-quality orthogonal edge routing
      "elk.layered.considerModelOrder.strategy": "NONE",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "LONGEST_PATH",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "false",
      // "elk.spacing.componentComponent": "50",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
      // Default node padding - important for port placement
      // "elk.padding": "[top=30, left=30, bottom=30, right=30]",
      // Port constraints for better electrical layout
      "elk.portConstraints": "FREE",
      // Node label placement
      "elk.nodeLabels.placement": "INSIDE H_LEFT V_TOP",
      "elk.portLabels.placement": "INSIDE",
      "elk.spacing.labelPortHorizontal": "5",
      "elk.spacing.labelPortVertical": "5",
      // "elk.portLabels.nextToPortIfPossible": "true",
      // Edge routing with proper straight lines
      // "elk.edges.sourcePoint": "FREE",
      // "elk.edges.targetPoint": "FREE",
      // Separate edges more clearly
      "elk.spacing.edgeEdge": "25",
      // Separate edges and nodes more clearly
      "elk.spacing.edgeNode": "30",
      // Aspect ratio settings - wider to accommodate ports better
      // "elk.aspectRatio": "1.6",
      "elk.nodeSize.constraints": "NODE_LABELS PORTS PORT_LABELS MINIMUM_SIZE",
      "elk.nodeSize.minimum": "(256, 256)",
      "elk.font.size": "24",
    };

    // Apply layout algorithm
    const layout = await this.elk.layout(graph, {
      layoutOptions,
    });

    return {
      ...layout,
      children: layout.children || [],
      edges: layout.edges || [],
    };
  }
}
