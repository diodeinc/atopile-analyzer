/**
 * Types representing an Atopile netlist structure
 * These types match the format found in demo.json
 */

/**
 * Module reference information
 */
export interface ModuleRef {
  source_path: string;
  module_name: string;
}

/**
 * Connection between two nodes
 */
export interface NodeConnection {
  left: string;
  right: string;
}

/**
 * Kind of instance in the netlist
 */
export enum InstanceKind {
  MODULE = "Module",
  COMPONENT = "Component",
  INTERFACE = "Interface",
  PORT = "Port",
}

/**
 * Represents the possible types of attribute values
 */
export interface AttributeValue {
  String?: string;
  Number?: number;
  Boolean?: boolean;
  Array?: AttributeValue[];
  Physical?: string;
}

/**
 * An instance in the netlist
 */
export interface Instance {
  module: ModuleRef;
  kind: InstanceKind;
  attributes: Record<string, AttributeValue | string>; // Support both new AttributeValue and legacy string format
  children: Record<string, string>;
  connections: NodeConnection[];
}

/**
 * The complete netlist structure
 */
export interface Netlist {
  instances: Record<string, Instance>;
}

/**
 * Optional metadata that might be present in the netlist
 */
export interface NetlistMetadata {
  version?: string;
  project?: string;
  timestamp?: string;
  // Add other metadata fields as needed
}

/**
 * Complete netlist with optional metadata
 */
export interface NetlistWithMetadata extends Netlist {
  metadata?: NetlistMetadata;
}
