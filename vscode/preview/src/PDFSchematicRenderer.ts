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

    // Draw resistor symbol
    doc.setDrawColor(this.options.colors.components);
    doc.rect(x, y, width, height);

    // Add label if present
    if (node.labels?.[0]) {
      doc.setFont(this.options.fonts.values);
      doc.setFontSize(10);
      doc.text(node.labels[0].text, x + width + 5, y + height / 2, {
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
        doc.text(port.labels[0].text, portX + 4, portY, { baseline: "middle" });
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

  private drawNode(doc: jsPDF, node: ElkNode) {
    switch (node.type) {
      case NodeType.RESISTOR:
        this.drawResistor(doc, node);
        break;
      case NodeType.CAPACITOR:
        this.drawCapacitor(doc, node);
        break;
      case NodeType.MODULE:
      case NodeType.COMPONENT:
        this.drawModule(doc, node);
        break;
      // Add other component types as needed
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

  async renderToPDF(instance_ref: string): Promise<Blob> {
    // Get layout from SchematicRenderer
    const layout = await this.layoutRenderer.render(instance_ref);

    // Calculate scale to fit page
    this.transform.scale = this.calculateScale(layout);

    // Create PDF document
    const doc = new jsPDF({
      orientation: "portrait",
      unit: "pt",
      format: [this.options.pageSize.width, this.options.pageSize.height],
    });

    // Set background color
    doc.setFillColor(this.options.colors.background);
    doc.rect(
      0,
      0,
      this.options.pageSize.width,
      this.options.pageSize.height,
      "F"
    );

    // Draw all nodes
    for (const node of layout.children) {
      this.drawNode(doc, node);
    }

    // Draw all connections
    this.drawConnections(doc, layout.edges);

    // Return the PDF as a blob
    return doc.output("blob");
  }
}
