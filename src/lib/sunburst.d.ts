export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface LayoutNode {
  depth: number;
  children?: LayoutNode[];
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
}

export const TWO_PI: number;

export function arcVisible(box: Box): boolean;

export function assignEqualAngles<T extends LayoutNode>(root: T): T;

export function zoomTarget(
  node: { x0: number; x1: number; y0: number; y1: number },
  focus: { x0: number; x1: number; depth: number }
): Box;
