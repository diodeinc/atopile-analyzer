import ELK from "elkjs/lib/elk-api.js";
import type { ELK as ELKType } from "elkjs/lib/elk-api";
import { InstanceKind, Netlist, AttributeValue } from "./types/NetlistTypes";

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
      width: 12,
      height: 30,
      labels: [
        {
          text: `${this._renderValue(instance.attributes.value) || ""}${
            footprint ? `\n${footprint}` : ""
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
      height: 20,
      labels: [
        {
          text: `${value || ""}${footprint ? `\n${footprint}` : ""}`,
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
      },
    };
  }

  _inductorNode(instance_ref: string): ElkNode {
    const instance = this.netlist.instances[instance_ref];
    const value = this._renderValue(instance.attributes.value);
    const footprint =
      this._getAttributeValue(instance.attributes.package) ||
      this._getAttributeValue(instance.attributes.footprint);

    return {
      id: instance_ref,
      type: NodeType.INDUCTOR,
      width: 40,
      height: 40,
      labels: [
        {
          text: `${value || ""}${footprint ? `\n${footprint}` : ""}`,
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
      },
    };
  }

  _netReferenceNode(
    ref_id: string,
    name: string,
    side: "NORTH" | "WEST" = "WEST",
    isGround: boolean = false
  ): ElkNode {
    // Use larger dimensions for ground symbols
    const width = isGround ? 30 : 15;
    const height = isGround ? 40 : 15;

    return {
      id: ref_id,
      type: NodeType.NET_REFERENCE,
      width: width,
      height: height,
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
        "elk.nodeSize.minimum": `(${width}, ${height})`,
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

  /// Analyze the graph and rewrite common sub-graphs as meta nodes with their own layout rules.
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
    for (const [_netId, edges] of netEntries) {
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
    let graph: ElkGraph = {
      id: instance_ref,
      children: nodes,
      edges: [],
    };

    graph = this._addConnectivity(graph);
    graph = this._createLayoutMetaNodes(graph);

    return graph;
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

  async render(instance_ref: string): Promise<ElkGraph> {
    const graph = this._graphForInstance(instance_ref);

    const layoutOptions = {
      "elk.algorithm": "layered",
      "elk.direction": "LEFT",
      "elk.nodeSize.constraints": "NODE_LABELS PORTS PORT_LABELS MINIMUM_SIZE",
      "elk.nodeSize.minimum": "(256, 256)",
      "elk.partitioning.activate": "true",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
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
