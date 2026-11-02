/**
 * Minimal surface of cytoscape 3.30 (ships no typings) used by headless layout scoring.
 */
declare module "cytoscape" {
  namespace cytoscape {
    interface NodeSingular {
      id(): string;
      data(key: string): unknown;
      position(): { x: number; y: number };
    }
    interface LayoutOptions {
      readonly name: string;
      readonly [key: string]: unknown;
    }
    interface Layouts {
      run(): this;
    }
    interface Core {
      layout(options: LayoutOptions): Layouts;
      nodes(): { map<T>(fn: (n: NodeSingular) => T): T[] };
      destroy(): void;
    }
    interface CoreOptions {
      readonly headless?: boolean;
      readonly styleEnabled?: boolean;
      readonly elements?: readonly { readonly data: object }[];
      readonly style?: readonly {
        readonly selector: string;
        readonly style: Record<string, unknown>;
      }[];
    }
  }
  function cytoscape(options: cytoscape.CoreOptions): cytoscape.Core;
  export default cytoscape;
}
