import { Instance, InstanceKind, Netlist } from "../types/NetlistTypes";
import {
  HierarchicalSchematic,
  SchematicLevel,
  Component,
  Port,
  Connection,
  ComponentType,
  SchematicConverter,
} from "../types/SchematicTypes";

/**
 * Represents a net (collection of electrically connected points) in the schematic
 */
interface Net {
  id: string;
  name: string;
  portIds: string[];
}

/**
 * Converter implementation to transform Atopile netlist data into our visualization format
 */
export class AtopileNetlistConverter implements SchematicConverter {
  // Track global nets across the entire schematic
  private globalNets: Map<string, Net> = new Map();

  /**
   * Convert an atopile netlist to our hierarchical schematic format
   */
  convert(netlist: Netlist): HierarchicalSchematic {
    // Reset global nets when starting a new conversion
    this.globalNets = new Map();

    const hierarchicalSchematic: HierarchicalSchematic = {
      levels: {},
      currentLevelId: "root",
      hierarchyRefs: [],
    };

    // First, identify and collect all nets from the netlist
    this.identifyGlobalNets(netlist);

    // Process the top level as a starting point
    const rootLevel = this.createRootLevel(netlist);
    hierarchicalSchematic.levels[rootLevel.id] = rootLevel;

    // Process modules that can have child schematics
    const moduleComponents = rootLevel.components.filter(
      (comp) => comp.type === ComponentType.MODULE || comp.hasChildren
    );

    // For each module, process its sub-schematic
    moduleComponents.forEach((moduleComp) => {
      this.processModuleHierarchy(
        netlist,
        hierarchicalSchematic,
        moduleComp.id,
        rootLevel.id,
        [rootLevel.name, moduleComp.name]
      );
    });

    return hierarchicalSchematic;
  }

  /**
   * Identify and collect all nets from the netlist
   */
  private identifyGlobalNets(netlist: Netlist): void {
    // Map to track port-to-net connections
    const portNetMap = new Map<string, string>();
    // Union-find data structure for tracking connected ports
    const parent: { [key: string]: string } = {};

    const find = (x: string): string => {
      if (!parent[x]) {
        parent[x] = x;
      } else if (parent[x] !== x) {
        parent[x] = find(parent[x]);
      }
      return parent[x];
    };

    const union = (x: string, y: string): void => {
      const rootX = find(x);
      const rootY = find(y);
      if (rootX !== rootY) {
        parent[rootY] = rootX;
      }
    };

    // Process all connections in the netlist to identify nets
    Object.entries(netlist.instances || {}).forEach(
      ([instancePath, instanceData]: [string, any]) => {
        if (
          instanceData.connections &&
          Array.isArray(instanceData.connections)
        ) {
          instanceData.connections.forEach((connection: any) => {
            if (connection.left && connection.right) {
              // Initialize union-find entries
              if (!parent[connection.left]) {
                parent[connection.left] = connection.left;
              }
              if (!parent[connection.right]) {
                parent[connection.right] = connection.right;
              }
              // Connect the ports
              union(connection.left, connection.right);
            }
          });
        }
      }
    );

    // Group ports by their connected component (net)
    const nets = new Map<string, string[]>();
    Object.keys(parent).forEach((portId) => {
      const root = find(portId);
      if (!nets.has(root)) {
        nets.set(root, []);
      }
      nets.get(root)!.push(portId);
    });

    // Create Net objects for each group of connected ports
    let netIndex = 0;
    nets.forEach((portIds, root) => {
      // Default net name
      let netName = `Net${netIndex}`;

      // Use the shortest port name
      if (portIds.length > 0) {
        // Get all extracted port names and their lengths
        const portNames = portIds.map((portId) => {
          const name = portId.split(":")[1] || "";
          return {
            name,
            length: name.length,
          };
        });

        // Sort by length (shortest first) and take the first one
        if (portNames.length > 0) {
          portNames.sort((a, b) => a.length - b.length);
          netName = portNames[0].name;
        }
      }

      // Create the net and store it
      const net: Net = {
        id: `net_${netIndex++}`,
        name: netName,
        portIds: portIds,
      };

      this.globalNets.set(root, net);

      // Map each port to this net
      portIds.forEach((portId) => {
        portNetMap.set(portId, root);
      });
    });
  }

  /**
   * Create the root schematic level from the netlist
   */
  private createRootLevel(netlist: Netlist): SchematicLevel {
    // Extract high-level modules from the netlist
    const components: Component[] = [];
    const connections: Connection[] = [];
    const portMap = new Map<string, Port>();
    const childIds: string[] = [];

    // Process instances to find top-level components/modules
    Object.entries(netlist.instances || {}).forEach(
      ([instancePath, instanceData]: [string, any]) => {
        // Only process top-level modules for the root view
        if (
          instanceData.kind === "Module" &&
          this.isTopLevelModule(instancePath, netlist)
        ) {
          const component = this.createComponentFromInstance(
            instancePath,
            instanceData
          );
          if (!component) return;
          components.push(component);

          // If this component has children, mark it as expandable
          if (Object.keys(instanceData.children || {}).length > 0) {
            component.hasChildren = true;
            childIds.push(component.id);
          }

          // Process ports for this component
          this.processComponentPorts(netlist, component, instanceData, portMap);
        }
      }
    );

    // Add net reference nodes and connections
    this.addNetReferenceNodes(components, connections, portMap);

    return {
      id: "root",
      name: "Top Level",
      description: "Root level schematic view",
      components,
      connections,
      children: childIds.length > 0 ? childIds : undefined,
    };
  }

  /**
   * Add net reference nodes to the schematic and connect them to appropriate ports
   */
  private addNetReferenceNodes(
    components: Component[],
    connections: Connection[],
    portMap: Map<string, Port>
  ): void {
    // For each global net, create a net reference node
    this.globalNets.forEach((net, rootPortId) => {
      // Find which ports in this level belong to this net
      const portsInThisLevel = net.portIds.filter((portId) =>
        portMap.has(portId)
      );

      // Check if the net has connections outside this level
      const hasExternalConnections =
        net.portIds.length > portsInThisLevel.length;

      // Only create a net reference if:
      // 1. There are ports in this level connected to this net (internal connections), AND
      // 2. The net also has connections outside this level (crosses boundaries)
      if (portsInThisLevel.length > 0 && hasExternalConnections) {
        // Create a net reference component
        const netReferenceComponent: Component = {
          id: `netref_${net.id}`,
          name: net.name,
          type: ComponentType.NET_REFERENCE,
          ports: [],
          hasChildren: false,
          attributes: {},
        };

        // Create a single port for the net reference
        const netRefPort: Port = {
          id: `${netReferenceComponent.id}_p1`,
          name: "connection",
          parentComponent: netReferenceComponent.id,
        };

        netReferenceComponent.ports.push(netRefPort);
        components.push(netReferenceComponent);

        // Add the port to the portMap
        portMap.set(netRefPort.id, netRefPort);

        connections.push({
          id: `conn_${net.id}_to_${netRefPort.id}`,
          portsIds: [netRefPort.id, ...portsInThisLevel],
        });
      }
    });
  }

  /**
   * Process a module to extract its hierarchical structure
   */
  private processModuleHierarchy(
    netlist: Netlist,
    schematic: HierarchicalSchematic,
    moduleId: string,
    parentId: string,
    path: string[]
  ): void {
    // Find the module instance in the netlist
    const moduleInstance = this.findInstanceById(netlist, moduleId);
    if (!moduleInstance) return;

    // Create a new schematic level for this module
    const moduleLevel = this.createModuleLevel(
      netlist,
      moduleId,
      moduleInstance
    );
    schematic.levels[moduleId] = moduleLevel;

    // Add hierarchy reference for this module
    schematic.hierarchyRefs.push({
      parentId,
      childId: moduleId,
      path,
    });

    // Set parent reference in the module level
    moduleLevel.parent = parentId;

    // Process submodules that can have child schematics
    const submoduleComponents = moduleLevel.components.filter(
      (comp) => comp.type === ComponentType.MODULE || comp.hasChildren
    );

    // For each submodule, process its sub-schematic
    submoduleComponents.forEach((submoduleComp) => {
      this.processModuleHierarchy(
        netlist,
        schematic,
        submoduleComp.id,
        moduleId,
        [...path, submoduleComp.name]
      );
    });
  }

  /**
   * Create a schematic level for a module
   */
  private createModuleLevel(
    netlist: Netlist,
    moduleId: string,
    moduleInstance: any
  ): SchematicLevel {
    const components: Component[] = [];
    const connections: Connection[] = [];
    const portMap = new Map<string, Port>();
    const childIds: string[] = [];

    // Create component for each child in the module - only create nodes for modules
    Object.entries(moduleInstance.children || {}).forEach(
      ([_childName, childPath]: [string, any]) => {
        const childInstance = this.findInstanceById(
          netlist,
          childPath as string
        );
        if (!childInstance) return;

        // Skip interfaces and signals - only create nodes for modules
        if (
          childInstance.kind !== InstanceKind.MODULE &&
          childInstance.kind !== InstanceKind.COMPONENT
        )
          return;

        const component = this.createComponentFromInstance(
          childPath as string,
          childInstance
        );
        if (!component) return;
        components.push(component);

        // If this child has children of its own, mark it as expandable
        if (Object.keys(childInstance.children || {}).length > 0) {
          component.hasChildren = true;
          childIds.push(component.id);
        }

        // Process ports for this component
        this.processComponentPorts(netlist, component, childInstance, portMap);
      }
    );

    // Process connections within this module
    this.processModuleConnections(
      moduleId,
      moduleInstance,
      connections,
      portMap
    );

    // Add net reference nodes and connections for this module level
    this.addNetReferenceNodes(components, connections, portMap);

    // Extract module name from the ID
    const moduleName = this.extractNameFromPath(moduleId);

    return {
      id: moduleId,
      name: moduleName,
      description: `Schematic view for ${moduleName}`,
      components,
      connections,
      children: childIds.length > 0 ? childIds : undefined,
    };
  }

  /**
   * Create a component from an instance in the netlist
   */
  private createComponentFromInstance(
    instancePath: string,
    instance: Instance
  ): Component | null {
    // Determine component type
    let componentType = ComponentType.OTHER;
    switch (instance.kind) {
      case "Component":
        componentType = this.determineComponentType(instance);
        break;
      case "Module":
        componentType = ComponentType.MODULE;
        break;
      case "Port":
        componentType = ComponentType.PORT;
        break;
      case "Interface":
        return null;
    }

    // Extract component name from path
    const name = this.extractNameFromPath(instancePath);

    return {
      id: instancePath,
      name,
      type: componentType,
      value: instance.attributes?.value as string,
      package: instance.attributes?.package as string,
      attributes: instance.attributes || {},
      hasChildren:
        instance.kind === InstanceKind.MODULE &&
        Object.keys(instance.children || {}).length > 0,
      ports: [], // Will be populated later
    };
  }

  /**
   * Process the ports of a component
   */
  private processComponentPorts(
    netlist: Netlist,
    component: Component,
    instance: Instance,
    portMap: Map<string, Port>
  ): void {
    // Process direct ports
    if (instance.kind === InstanceKind.PORT) {
      // If the instance itself is a port, add it to its parent
      const port: Port = {
        id: component.id,
        name: component.name,
        parentComponent: component.id.split(".").slice(0, -1).join("."),
      };
      component.ports.push(port);
      portMap.set(port.id, port);
    }
    // Process child ports for modules and interfaces
    else if (
      instance.kind === InstanceKind.MODULE ||
      instance.kind === InstanceKind.INTERFACE ||
      instance.kind === InstanceKind.COMPONENT
    ) {
      // For each child, process interfaces, ports, and signals
      Object.entries(instance.children || {}).forEach(
        ([childName, childPath]: [string, string]) => {
          // Find the child instance data
          const childInstance = this.findInstanceById(
            netlist,
            childPath as string
          );

          if (!childInstance) return;

          const isInterface = childInstance.kind === InstanceKind.INTERFACE;
          const isPort = childInstance.kind === InstanceKind.PORT;

          // Process interfaces specially - lift their ports to the parent component
          if (isInterface) {
            // Process all ports within this interface
            Object.entries(childInstance.children || {}).forEach(
              ([interfacePortName, interfacePortPath]: [string, any]) => {
                const interfacePortInstance = this.findInstanceById(
                  netlist,
                  interfacePortPath as string
                );

                // Only create ports for actual port types within the interface
                if (interfacePortInstance?.kind === InstanceKind.PORT) {
                  // Create a port that represents this interface port on the parent component
                  const port: Port = {
                    id: interfacePortPath as string,
                    name: `${childName}.${interfacePortName}`, // Show as interface.port
                    parentComponent: component.id,
                  };

                  component.ports.push(port);
                  portMap.set(port.id, port);
                }
              }
            );
          } else if (isPort) {
            // Add port for this child (direct port or signal)
            const port: Port = {
              id: childPath as string,
              name: childName,
              parentComponent: component.id,
            };

            component.ports.push(port);
            portMap.set(port.id, port);
          }
        }
      );
    }

    component.ports.sort((a, b) => {
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Process connections within a module
   */
  private processModuleConnections(
    moduleId: string,
    moduleInstance: Instance,
    connections: Connection[],
    portMap: Map<string, Port>
  ): void {
    if (
      moduleInstance.connections &&
      Array.isArray(moduleInstance.connections)
    ) {
      // Map to track which global nets are present in this module level
      const localNets = new Map<string, string[]>();

      // Process connections to find which global nets are relevant to this module
      moduleInstance.connections.forEach((connection: any) => {
        // For each connection endpoint, find the global net it belongs to
        if (connection.left && connection.right) {
          // Find the global nets these ports belong to
          Array.from(this.globalNets.entries()).forEach(([netRoot, net]) => {
            // Check if either endpoint is in this net
            if (
              net.portIds.includes(connection.left) ||
              net.portIds.includes(connection.right)
            ) {
              // Filter the net's ports to only those present in the current module's portMap
              const localPorts = net.portIds.filter((portId: string) =>
                portMap.has(portId)
              );

              // Only add this net if it contains ports in this module
              if (localPorts.length > 0) {
                localNets.set(netRoot, localPorts);
              }
            }
          });
        }
      });

      // Create a Connection for each net computed
      let netIndex = 0;
      localNets.forEach((ports, netRoot) => {
        // Get the global net to use its ID/name
        const globalNet = this.globalNets.get(netRoot);
        if (globalNet) {
          connections.push({
            id: `${moduleId}_net_${globalNet.id}`,
            portsIds: ports,
          });
        } else {
          connections.push({
            id: `${moduleId}_net_${netIndex++}`,
            portsIds: ports,
          });
        }
      });
    }
  }

  /**
   * Get a specific level from the hierarchical schematic
   */
  getLevel(schematic: HierarchicalSchematic, levelId: string): SchematicLevel {
    return schematic.levels[levelId];
  }

  /**
   * Navigate to a child level
   */
  navigateToChild(
    schematic: HierarchicalSchematic,
    childId: string
  ): HierarchicalSchematic {
    return {
      ...schematic,
      currentLevelId: childId,
    };
  }

  /**
   * Navigate to the parent level
   */
  navigateToParent(schematic: HierarchicalSchematic): HierarchicalSchematic {
    const currentLevel = schematic.levels[schematic.currentLevelId];
    if (!currentLevel.parent) return schematic; // Already at root

    return {
      ...schematic,
      currentLevelId: currentLevel.parent,
    };
  }

  /**
   * Helper function to check if a module is at the top level
   */
  private isTopLevelModule(instancePath: string, netlist: Netlist): boolean {
    // Get the module name from the path
    const [_, moduleName] = instancePath.split(":");
    const moduleNameParts = moduleName.split(".");
    return moduleNameParts.length === 1;
  }

  /**
   * Helper function to find an instance by its ID/path
   */
  private findInstanceById(netlist: Netlist, instanceId: string): any {
    return netlist.instances ? netlist.instances[instanceId] : null;
  }

  /**
   * Check if a component is a signal or port
   */
  private isSignalOrPin(instance: any): boolean {
    if (!instance || instance.kind !== "Component") return false;
    const type = (instance.type || "").toLowerCase();
    return (
      type === "signal" ||
      type.includes("pin") ||
      type.includes("port") ||
      type.includes("interface")
    );
  }

  // No longer needed as we're only relying on type information, not name patterns

  /**
   * Extract a human-readable name from a path
   */
  private extractNameFromPath(path: string): string {
    // Extract the last part of the path after the last dot or slash
    const parts = path.split(/[.\/]/);
    return parts[parts.length - 1];
  }

  /**
   * Determine the component type based on instance data
   */
  private determineComponentType(instance: any): ComponentType {
    const name = instance.module?.module_name || "";
    const path = instance.module?.source_path || "";
    const fullPath = `${path}:${name}`;

    // Handle special known atopile components based on paths
    if (fullPath.includes("Resistor") || fullPath.includes("resistor")) {
      return ComponentType.RESISTOR;
    }
    if (
      fullPath.includes("Capacitor") ||
      fullPath.includes("capacitor") ||
      fullPath.includes("Cap")
    ) {
      return ComponentType.CAPACITOR;
    }

    // Default to module for complex components
    if (instance.kind === "Component") {
      return ComponentType.IC;
    } else if (instance.kind === "Module") {
      return ComponentType.MODULE;
    }

    return ComponentType.OTHER;
  }
}
