import { jsPDF } from "jspdf";
import { Netlist } from "./types/NetlistTypes";
import {
  SchematicRenderer,
  SchematicConfig,
  DEFAULT_CONFIG,
  ElkNode,
  ElkEdge,
  NodeType,
  ElkGraph,
} from "./renderer";

export interface PDFRenderOptions {
  pageSize: {
    width: number; // Width in points (72 points = 1 inch)
    height: number; // Height in points
    margin: number; // Margin in points
  };
  colors: {
    background: string;
    components: string;
    nets: string;
    labels: string;
  };
  fonts: {
    labels: string;
    values: string;
    ports: string;
  };
  components: {
    scale: number; // Global scale factor
    spacing: number; // Space between components
  };
}

export const DEFAULT_PDF_OPTIONS: PDFRenderOptions = {
  pageSize: {
    width: 595.28, // A4 width in points
    height: 841.89, // A4 height in points
    margin: 20,
  },
  colors: {
    background: "#FFFFFF",
    components: "#000000",
    nets: "#000000",
    labels: "#000000",
  },
  fonts: {
    labels: "helvetica",
    values: "helvetica",
    ports: "helvetica",
  },
  components: {
    scale: 1.0,
    spacing: 50,
  },
};

export class PDFSchematicRenderer {
  private layoutRenderer: SchematicRenderer;
  private options: PDFRenderOptions;
  private transform: {
    scale: number;
    offsetX: number;
    offsetY: number;
  };

  constructor(
    netlist: Netlist,
    config: Partial<SchematicConfig> = {},
    options: Partial<PDFRenderOptions> = {}
  ) {
    this.layoutRenderer = new SchematicRenderer(netlist, config);
    this.options = { ...DEFAULT_PDF_OPTIONS, ...options };
    this.transform = {
      scale: 1,
      offsetX: this.options.pageSize.margin,
      offsetY: this.options.pageSize.margin,
    };
  }

  private toPageCoords(x: number, y: number): [number, number] {
    return [
      x * this.transform.scale + this.transform.offsetX,
      y * this.transform.scale + this.transform.offsetY,
    ];
  }

  private drawResistor(doc: jsPDF, node: ElkNode) {
    const [x, y] = this.toPageCoords(node.x || 0, node.y || 0);
    const width = (node.width || 0) * this.transform.scale;
    const height = (node.height || 0) * this.transform.scale;

    // Draw resistor symbol - narrow rectangle
    const resistorWidth = 12 * this.transform.scale;
    const resistorHeight = 28 * this.transform.scale;
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    // Draw vertical lines to connect to ports
    doc.setDrawColor(this.options.colors.components);
    doc.setLineWidth(1.5 * this.transform.scale);

    // Top line
    doc.line(centerX, y, centerX, centerY - resistorHeight / 2);
    // Bottom line
    doc.line(centerX, centerY + resistorHeight / 2, centerX, y + height);

    // Draw resistor body (rectangle)
    doc.rect(
      centerX - resistorWidth / 2,
      centerY - resistorHeight / 2,
      resistorWidth,
      resistorHeight
    );

    // Add label if present
    if (node.labels?.[0]) {
      doc.setFont(this.options.fonts.values);
      doc.setFontSize(10 * this.transform.scale);
      doc.text(node.labels[0].text, centerX + resistorWidth + 5, centerY, {
        baseline: "middle",
      });
    }
  }

  private drawCapacitor(doc: jsPDF, node: ElkNode) {
    const [x, y] = this.toPageCoords(node.x || 0, node.y || 0);
    const width = (node.width || 0) * this.transform.scale;
    const height = (node.height || 0) * this.transform.scale;
    const plateGap = 4 * this.transform.scale;

    doc.setDrawColor(this.options.colors.components);

    // Draw capacitor plates
    const centerX = x + width / 2;
    doc.line(centerX, y, centerX, y + (height - plateGap) / 2);
    doc.line(
      x,
      y + (height - plateGap) / 2,
      x + width,
      y + (height - plateGap) / 2
    );
    doc.line(
      x,
      y + (height + plateGap) / 2,
      x + width,
      y + (height + plateGap) / 2
    );
    doc.line(centerX, y + (height + plateGap) / 2, centerX, y + height);

    // Add label if present
    if (node.labels?.[0]) {
      doc.setFont(this.options.fonts.values);
      doc.setFontSize(10);
      doc.text(node.labels[0].text, x + width + 5, y + height / 2, {
        baseline: "middle",
      });
    }
  }

  private drawModule(doc: jsPDF, node: ElkNode) {
    const [x, y] = this.toPageCoords(node.x || 0, node.y || 0);
    const width = (node.width || 0) * this.transform.scale;
    const height = (node.height || 0) * this.transform.scale;

    // Draw module box
    doc.setDrawColor(this.options.colors.components);
    doc.rect(x, y, width, height);

    // Draw module name
    if (node.labels?.[0]) {
      doc.setFont(this.options.fonts.labels);
      doc.setFontSize(12);
      doc.text(node.labels[0].text, x + 5, y + 15);
    }

    // Draw ports
    for (const port of node.ports || []) {
      const [portX, portY] = this.toPageCoords(
        (port.x || 0) + (node.x || 0),
        (port.y || 0) + (node.y || 0)
      );

      doc.setFillColor(this.options.colors.components);
      doc.circle(portX, portY, 2 * this.transform.scale, "F");

      // Draw port label
      if (port.labels?.[0]) {
        doc.setFont(this.options.fonts.ports);
        doc.setFontSize(8);

        // Determine if port is on the right side
        const portSide = port.properties?.["port.side"] || "WEST";
        const isRightSide = portSide === "EAST";

        if (isRightSide) {
          // For right-side ports, place label inside and right-aligned
          doc.text(port.labels[0].text, portX - 4, portY, {
            baseline: "middle",
            align: "right",
          });
        } else {
          // For left-side ports, place label outside and left-aligned
          doc.text(port.labels[0].text, portX + 4, portY, {
            baseline: "middle",
            align: "left",
          });
        }
      }
    }
  }

  private drawConnections(doc: jsPDF, edges: ElkEdge[]) {
    doc.setDrawColor(this.options.colors.nets);

    for (const edge of edges) {
      if (!edge.sections?.[0]) continue;

      const section = edge.sections[0];
      const points = [
        section.startPoint,
        ...(section.bendPoints || []),
        section.endPoint,
      ];

      // Draw the connection line
      for (let i = 0; i < points.length - 1; i++) {
        const [x1, y1] = this.toPageCoords(points[i].x, points[i].y);
        const [x2, y2] = this.toPageCoords(points[i + 1].x, points[i + 1].y);
        doc.line(x1, y1, x2, y2);
      }

      // Draw junction points
      if (edge.junctionPoints) {
        doc.setFillColor(this.options.colors.nets);
        for (const point of edge.junctionPoints) {
          const [x, y] = this.toPageCoords(point.x, point.y);
          doc.circle(x, y, 2 * this.transform.scale, "F");
        }
      }
    }
  }

  private drawNetReference(doc: jsPDF, node: ElkNode) {
    const [x, y] = this.toPageCoords(node.x || 0, node.y || 0);
    const width = (node.width || 0) * this.transform.scale;
    const height = (node.height || 0) * this.transform.scale;
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    doc.setDrawColor(this.options.colors.components);
    doc.setLineWidth(1.5 * this.transform.scale);

    if (node.isGround) {
      // Ground symbol dimensions
      const symbolWidth = 20 * this.transform.scale;
      const lineSpacing = 4 * this.transform.scale;
      const verticalLineLength = 10 * this.transform.scale;

      // Draw vertical line from port to ground symbol
      doc.line(
        centerX,
        y,
        centerX,
        y + height - verticalLineLength - 3 * lineSpacing
      );

      // Draw ground symbol at the bottom
      const groundY = y + height - 3 * lineSpacing;
      const groundLineWidths = [
        symbolWidth,
        symbolWidth * 0.75,
        symbolWidth * 0.5,
      ];

      // Draw horizontal ground lines
      for (let i = 0; i < 3; i++) {
        const lineWidth = groundLineWidths[i];
        doc.line(
          centerX - lineWidth / 2,
          groundY + i * lineSpacing,
          centerX + lineWidth / 2,
          groundY + i * lineSpacing
        );
      }
    } else {
      // Draw connection line from port
      const portY = node.ports?.[0]?.y || y;
      const [, portPageY] = this.toPageCoords(0, portY);
      doc.line(centerX, portPageY, centerX, centerY);

      // Regular net reference - small circle with dot
      const circleRadius = 3 * this.transform.scale;
      doc.circle(centerX, centerY, circleRadius, "S");
      doc.setFillColor(this.options.colors.components);
      doc.circle(centerX, centerY, 1 * this.transform.scale, "F");

      // Add net name label
      if (node.labels?.[0]) {
        doc.setFont(this.options.fonts.labels);
        doc.setFontSize(10 * this.transform.scale);
        doc.text(node.labels[0].text, centerX + circleRadius + 5, centerY, {
          align: "left",
          baseline: "middle",
        });
      }
    }
  }

  private drawInductor(doc: jsPDF, node: ElkNode) {
    const [x, y] = this.toPageCoords(node.x || 0, node.y || 0);
    const width = (node.width || 0) * this.transform.scale;
    const height = (node.height || 0) * this.transform.scale;
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    doc.setDrawColor(this.options.colors.components);
    doc.setLineWidth(1.5 * this.transform.scale);

    // Draw vertical lines to ports
    doc.line(centerX, y, centerX, centerY - 15 * this.transform.scale);
    doc.line(centerX, centerY + 15 * this.transform.scale, centerX, y + height);

    // Draw inductor coils
    const coilWidth = 12 * this.transform.scale;
    const coilHeight = 6 * this.transform.scale;
    const numCoils = 4;
    const totalCoilsHeight = numCoils * coilHeight;
    let startY = centerY - totalCoilsHeight / 2;

    // Draw arcs for inductor using line segments
    for (let i = 0; i < numCoils; i++) {
      const arcY = startY + i * coilHeight;
      const segments = 8; // Number of line segments per arc

      // Generate points for a half-sine wave
      for (let j = 0; j < segments; j++) {
        const t1 = j / segments;
        const t2 = (j + 1) / segments;

        const x1 = centerX - coilWidth / 2 + coilWidth * Math.sin(t1 * Math.PI);
        const y1 = arcY + coilHeight * t1;

        const x2 = centerX - coilWidth / 2 + coilWidth * Math.sin(t2 * Math.PI);
        const y2 = arcY + coilHeight * t2;

        doc.line(x1, y1, x2, y2);
      }
    }

    // Add label if present
    if (node.labels?.[0]) {
      doc.setFont(this.options.fonts.values);
      doc.setFontSize(10 * this.transform.scale);
      doc.text(node.labels[0].text, centerX + coilWidth + 5, centerY, {
        baseline: "middle",
      });
    }
  }

  private drawNode(doc: jsPDF, node: ElkNode) {
    switch (node.type) {
      case NodeType.RESISTOR:
        this.drawResistor(doc, node);
        break;
      case NodeType.CAPACITOR:
        this.drawCapacitor(doc, node);
        break;
      case NodeType.INDUCTOR:
        this.drawInductor(doc, node);
        break;
      case NodeType.MODULE:
      case NodeType.COMPONENT:
        this.drawModule(doc, node);
        break;
      case NodeType.NET_REFERENCE:
        this.drawNetReference(doc, node);
        break;
    }
  }

  private calculateScale(layout: ElkGraph) {
    const availableWidth =
      this.options.pageSize.width - 2 * this.options.pageSize.margin;
    const availableHeight =
      this.options.pageSize.height - 2 * this.options.pageSize.margin;

    // Find the bounding box of all nodes
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of layout.children) {
      const x = node.x || 0;
      const y = node.y || 0;
      const width = node.width || 0;
      const height = node.height || 0;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }

    const layoutWidth = maxX - minX;
    const layoutHeight = maxY - minY;

    if (layoutWidth === 0 || layoutHeight === 0) {
      return 1;
    }

    const scaleX = availableWidth / layoutWidth;
    const scaleY = availableHeight / layoutHeight;

    return Math.min(scaleX, scaleY, 1) * this.options.components.scale;
  }

  private async renderModule(
    doc: jsPDF,
    instance_ref: string,
    isFirstPage: boolean = false
  ) {
    // Add a new page if this isn't the first module
    if (!isFirstPage) {
      doc.addPage();
    }

    // Get the layout for this module
    const graph = await this.layoutRenderer.render(instance_ref);

    // Calculate scale and position to fit the graph on the page
    const pageWidth =
      this.options.pageSize.width - 2 * this.options.pageSize.margin;
    const pageHeight =
      this.options.pageSize.height - 2 * this.options.pageSize.margin;

    // Find the bounds of the graph
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const node of graph.children) {
      const x = node.x || 0;
      const y = node.y || 0;
      const width = node.width || 0;
      const height = node.height || 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }

    // Calculate scale to fit
    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const scaleX = pageWidth / graphWidth;
    const scaleY = pageHeight / graphHeight;
    this.transform.scale = Math.min(scaleX, scaleY, 1) * 0.9; // Use same scaling logic as React viewer

    // Center the graph on the page
    const scaledWidth = graphWidth * this.transform.scale;
    const scaledHeight = graphHeight * this.transform.scale;
    this.transform.offsetX =
      this.options.pageSize.margin +
      (pageWidth - scaledWidth) / 2 -
      minX * this.transform.scale;
    this.transform.offsetY =
      this.options.pageSize.margin +
      (pageHeight - scaledHeight) / 2 -
      minY * this.transform.scale;

    // Add a title for the module
    doc.setFont(this.options.fonts.labels, "bold");
    doc.setFontSize(16);
    const title = instance_ref.split(".").pop() || instance_ref;
    const titleWidth = doc.getTextWidth(title);
    doc.text(
      title,
      (this.options.pageSize.width - titleWidth) / 2,
      this.options.pageSize.margin
    );

    // Set line width for all drawings
    doc.setLineWidth(1.5 * this.transform.scale);

    // Draw all nodes
    for (const node of graph.children) {
      this.drawNode(doc, node);
    }

    // Draw all connections
    this.drawConnections(doc, graph.edges);
  }

  private getSubmodules(instance_ref: string): string[] {
    const instance = this.layoutRenderer.netlist.instances[instance_ref];
    if (!instance) return [];

    const submodules: string[] = [];

    // Add the current module if it's a module
    if (instance.kind === "Module") {
      submodules.push(instance_ref);

      // Recursively check all children
      for (const [_, child_ref] of Object.entries(instance.children)) {
        const child = this.layoutRenderer.netlist.instances[child_ref];
        if (child?.kind === "Module") {
          // Recursively get submodules of this child
          submodules.push(...this.getSubmodules(child_ref));
        }
      }
    }

    return submodules;
  }

  async render(rootModule: string): Promise<jsPDF> {
    // Create a new PDF document
    const doc = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: [this.options.pageSize.width, this.options.pageSize.height],
    });

    // Get all modules in the subtree of the root module
    const modules = this.getSubmodules(rootModule);

    // Render each module on its own page
    for (let i = 0; i < modules.length; i++) {
      await this.renderModule(doc, modules[i], i === 0);
    }

    return doc;
  }
}
