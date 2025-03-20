import ELK from "elkjs/lib/elk-api.js";
import type { ELK as ELKType } from "elkjs/lib/elk-api";
import { InstanceKind, Netlist, AttributeValue } from "./types/NetlistTypes";

export enum NodeType {
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

    return {
      id: instance_ref,
      type: NodeType.RESISTOR,
      width: 40,
      height: 100,
      labels: [
        {
          text: `${this._renderValue(instance.attributes.value) || ""}${
            footprint ? `\n${footprint}` : ""
          }`,
          x: 45, // Position label to the right of the resistor
          y: 50, // Vertically center the label
          width: 128,
          height: 100,
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
        "elk.nodeSize.minimum": "(40, 100)",
      },
    };
  }

  _capacitorNode(instance_ref: string): ElkNode {
    const instance = this.netlist.instances[instance_ref];
    const value = this._renderValue(instance.attributes.value);
    const footprint =
      this._getAttributeValue(instance.attributes.package) ||
      this._getAttributeValue(instance.attributes.footprint);

    return {
      id: instance_ref,
      type: NodeType.CAPACITOR,
      width: 40,
      height: 40,
      labels: [
        {
          text: `${value || ""}${footprint ? `\n${footprint}` : ""}`,
          x: 45, // Position label to the right of the capacitor
          y: 20, // Vertically center the label
          width: 128,
          height: 100,
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
      },
    };
  }

  _inductorNode(instance_ref: string): ElkNode {
    return {
      id: instance_ref,
      type: NodeType.INDUCTOR,
      width: 40,
      height: 60,
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
        "elk.nodeSize.minimum": "(40, 60)",
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

      // For each node in the graph
      for (const node of graph.children) {
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

          if (matchingInternalPorts.length > 0) {
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
      if (portsInNetToInstanceRef.size >= 1 && outsideConnections.size >= 1) {
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
        const node = graph.children.find((node) => node.id === instanceRef);
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
        });
      }

      // Next, connect the last passive port (or if we don't have, to a module
      // port) to all of the net reference ports.
      const netReferenceConnectorPort =
        passivePorts.length > 0
          ? passivePorts[passivePorts.length - 1]
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
        });
      }

      //   if (portsList.length > 3) {
      //     // Create a junction node for this net
      //     const junctionNodeId = `${netName}_junction`;
      //     const junctionNodePortId = `${junctionNodeId}_port`;
      //     graph.children.push({
      //       id: junctionNodeId,
      //       width: 0,
      //       height: 0,
      //       type: NodeType.NET_JUNCTION,
      //       ports: [
      //         {
      //           id: junctionNodePortId,
      //           width: -1,
      //           height: -1,
      //           properties: {
      //             "port.anchor": "(0, 0)",
      //             "port.alignment": "CENTER",
      //           },
      //         },
      //       ],
      //       properties: {
      //         "elk.padding": "[top=0, left=0, bottom=0, right=0]",
      //         "elk.nodeSize.constraints": "MINIMUM_SIZE",
      //         "elk.nodeSize.minimum": "(0, 0)",
      //       },
      //     });

      //     // Connect every port to the junction node
      //     for (const [port, instanceRef] of portsList) {
      //       graph.edges.push({
      //         id: `${junctionNodeId}-${port}`,
      //         sources: [junctionNodePortId],
      //         targets: [port],
      //         sourceComponentRef: junctionNodeId,
      //         targetComponentRef: instanceRef,
      //         netId: netName,
      //         properties: {
      //           "elk.edge.thickness": "0.1", // Make edges very thin
      //         },
      //       });
      //     }

      //     // If we have a net reference, connect it to the junction node
      //     if (
      //       portsInGraphToInstanceRef.size >= 1 &&
      //       outsideConnections.size >= 1
      //     ) {
      //       const netRefId = `${netName}_ref`;
      //       const netRefNode = this._netReferenceNode(netRefId, netName);
      //       graph.children.push(netRefNode);

      //       graph.edges.push({
      //         id: `${netName}_ref_edge`,
      //         sources: [junctionNodePortId],
      //         targets: [netRefId],
      //         sourceComponentRef: junctionNodeId,
      //         targetComponentRef: netRefId,
      //         netId: netName,
      //       });
      //     }
      //   } else {
      //     for (let i = 0; i < portsList.length; i++) {
      //       for (let j = i + 1; j < portsList.length; j++) {
      //         graph.edges.push({
      //           id: `${portsList[i][0]}-${portsList[j][0]}`,
      //           sources: [portsList[i][0]],
      //           targets: [portsList[j][0]],
      //           sourceComponentRef: portsList[i][1],
      //           targetComponentRef: portsList[j][1],
      //           netId: netName,
      //         });
      //       }
      //     }

      //     // If we have a net reference, connect it to all nodes
      //     if (
      //       portsInGraphToInstanceRef.size >= 1 &&
      //       outsideConnections.size >= 1
      //     ) {
      //       const netRefId = `${netName}_ref`;
      //       const netRefNode = this._netReferenceNode(netRefId, netName);
      //       graph.children.push(netRefNode);

      //       for (const [port, instanceRef] of portsList) {
      //         graph.edges.push({
      //           id: `${netName}_ref_edge`,
      //           sources: [port],
      //           targets: [netRefId],
      //           sourceComponentRef: instanceRef,
      //           targetComponentRef: netRefId,
      //           netId: netName,
      //         });
      //       }
      //     }
      //   }
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
      "elk.layered.considerModelOrder.strategy": "PREFER_EDGES",
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
