/**
 * Types for electrical schematic visualization
 * These types represent a hierarchical schematic structure
 * where we can display one level at a time and navigate between levels
 */

import { Netlist } from "./NetlistTypes";

/**
 * Component types in the schematic
 */
export enum ComponentType {
  IC = "ic",
  RESISTOR = "resistor",
  CAPACITOR = "capacitor",
  INDUCTOR = "inductor",
  DIODE = "diode",
  TRANSISTOR = "transistor",
  CONNECTOR = "connector",
  BUTTON = "button",
  MODULE = "module",
  PORT = "port",
  JUNCTION = "junction",
  NET_REFERENCE = "net_reference",
  OTHER = "other",
}

/**
 * Interface that represents a port on a component
 */
export interface Port {
  id: string;
  name: string;
  parentComponent: string; // ID of the component this port belongs to
}

/**
 * Interface that represents a component in the schematic
 */
export interface Component {
  id: string;
  name: string;
  type: ComponentType;

  // Component properties
  value?: string; // e.g., resistance value, capacitance value, etc.
  package?: string; // e.g., SOIC-8, TO-92, etc.
  attributes?: Record<string, string | number | boolean>; // Arbitrary attributes
  // Nesting properties
  hasChildren?: boolean; // Indicates if this component has a sub-schematic
  // Ports
  ports: Port[];
}

/**
 * Interface that represents a connection between two ports
 */
export interface Connection {
  id: string;
  portsIds: string[];
  // Optional routing hints - can be used by layout algorithm
  routingPoints?: { x: number; y: number }[];
}

/**
 * Interface that represents a parent-child relationship for hierarchical navigation
 */
export interface HierarchyRef {
  parentId: string | null; // null for top level
  childId: string;
  path: string[]; // Path to this child from root, useful for breadcrumb navigation
}

/**
 * Interface that represents a complete schematic level
 */
export interface SchematicLevel {
  id: string;
  name: string;
  description?: string;
  // Components and connections at this level
  components: Component[];
  connections: Connection[];
  // Navigation
  parent?: string; // ID of parent module, if this is a sub-schematic
  children?: string[]; // IDs of child modules that can be expanded
}

/**
 * Interface that represents a complete hierarchical schematic
 * with multiple levels
 */
export interface HierarchicalSchematic {
  // All schematic levels by ID
  levels: Record<string, SchematicLevel>;
  // The current level being viewed
  currentLevelId: string;
  // Hierarchy reference map for navigation
  hierarchyRefs: HierarchyRef[];
}

/**
 * Interface for converting from atopile/demo.json to our visualization format
 */
export interface SchematicConverter {
  // Convert an atopile netlist to our hierarchical schematic format
  convert(netlist: Netlist): HierarchicalSchematic;

  // Get a specific level from the hierarchical schematic
  getLevel(schematic: HierarchicalSchematic, levelId: string): SchematicLevel;

  // Navigate to a child level
  navigateToChild(
    schematic: HierarchicalSchematic,
    childId: string
  ): HierarchicalSchematic;

  // Navigate to the parent level
  navigateToParent(schematic: HierarchicalSchematic): HierarchicalSchematic;
}
