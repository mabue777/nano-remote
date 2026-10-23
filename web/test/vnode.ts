// Reading the element tree a Preact component returns, for unit tests without a DOM: call the component as a
// function and inspect what it would render. Only host elements ('div', 'button', ...) are walked; a nested
// function component shows up as one node with its props.
import type { ComponentChildren, VNode } from 'preact';

export type Props = Record<string, unknown> & { children?: ComponentChildren };
export type Node = VNode<Props>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

/** The direct children that are elements, in order (strings, numbers, false and null dropped). */
export function childNodes(node: Node): Node[] {
  return flatten(node.props.children).filter(isNode);
}

function flatten(children: ComponentChildren): unknown[] {
  return Array.isArray(children) ? children.flatMap((child) => flatten(child as ComponentChildren)) : [children];
}

/** Every element in the tree, the root first (depth first). */
export function allNodes(node: Node): Node[] {
  return [node, ...childNodes(node).flatMap(allNodes)];
}

/** The one element matching `match`; throws when there is none or more than one. */
export function only(node: Node, match: (node: Node) => boolean): Node {
  const found = allNodes(node).filter(match);
  if (found.length !== 1) throw new Error(`expected one match, found ${found.length}`);
  return found[0]!;
}

export const byType = (type: string) => (node: Node) => node.type === type;

/** The text the tree renders, concatenated (what a screen reader would read, without labels). */
export function text(children: ComponentChildren): string {
  return flatten(children)
    .map((child) => (isNode(child) ? text(child.props.children) : typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('');
}

/** Calls an element's event handler prop, e.g. `fire(button, 'onClick', event)`. */
export function fire(node: Node, handler: string, event: unknown = {}): void {
  const fn = node.props[handler];
  if (typeof fn !== 'function') throw new Error(`no ${handler} on <${String(node.type)}>`);
  (fn as (event: unknown) => void)(event);
}
