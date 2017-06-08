import { clear, Cursor, DestroyableBounds, single, Bounds } from '../bounds';

import { DOMChanges, DOMTreeConstruction } from '../dom/helper';
import { isString, isSafeString, isNode, isEmpty } from '../dom/normalize';

import { Option, Destroyable, Stack, LinkedList, LinkedListNode, assert, expect } from '@glimmer/util';

import { Environment } from '../environment';

import { VM } from '../vm';

import { VersionedReference } from '@glimmer/reference';

import { DynamicContent, DynamicContentWrapper } from './content/dynamic';
import DynamicTextContent from './content/text';
import DynamicNodeContent from './content/node';
import DynamicHTMLContent, { DynamicTrustedHTMLContent } from './content/html';

import {
  SimpleElementOperations
} from '../compiled/opcodes/dom';

import * as Simple from '../dom/interfaces';
import { Opaque } from "@glimmer/interfaces";

export interface FirstNode {
  firstNode(): Option<Simple.Node>;
}

export interface LastNode {
  lastNode(): Option<Simple.Node>;
}

class First {
  constructor(private node: Node) { }

  firstNode(): Node {
    return this.node;
  }
}

class Last {
  constructor(private node: Node) { }

  lastNode(): Node {
    return this.node;
  }
}

export interface ElementOperations {
  addStaticAttribute(element: Simple.Element, name: string, value: string): void;
  addStaticAttributeNS(element: Simple.Element, namespace: string, name: string, value: string): void;
  addDynamicAttribute(element: Simple.Element, name: string, value: VersionedReference<string>, isTrusting: boolean): void;
  addDynamicAttributeNS(element: Simple.Element, namespace: string, name: string, value: VersionedReference<string>, isTrusting: boolean): void;
  flush(element: Simple.Element, vm: VM): void;
}

export class Fragment implements Bounds {
  private bounds: Bounds;

  constructor(bounds: Bounds) {
    this.bounds = bounds;
  }

  parentElement(): Simple.Element {
    return this.bounds.parentElement();
  }

  firstNode(): Option<Simple.Node> {
    return this.bounds.firstNode();
  }

  lastNode(): Option<Simple.Node> {
    return this.bounds.lastNode();
  }

  update(bounds: Bounds) {
    this.bounds = bounds;
  }
}

export interface DOMStack {
  pushRemoteElement(element: Simple.Element, nextSibling: Option<Simple.Node>): void;
  popRemoteElement(): void;
  popElement(): void;
  openElement(tag: string, _operations?: ElementOperations): Simple.Element;
  flushElement(): void;
  appendText(string: string): Simple.Text;
  appendComment(string: string): Simple.Comment;
  appendTrustingDynamicContent(reference: Opaque): DynamicContentWrapper;
  appendCautiousDynamicContent(reference: Opaque): DynamicContentWrapper;
  setStaticAttribute(name: string, value: string): void;
  setStaticAttributeNS(namespace: string, name: string, value: string): void;
  setDynamicAttribute(name: string, reference: VersionedReference<string>, isTrusting: boolean): void;
  setDynamicAttributeNS(namespace: string, name: string, reference: VersionedReference<string>, isTrusting: boolean): void;
  closeElement(): void;
}

export interface ElementBuilder extends Cursor, DOMStack {
  nextSibling: Option<Simple.Node>;
  dom: DOMTreeConstruction;
  updateOperations: DOMChanges;
  constructing: Option<Simple.Element>;
  operations: Option<ElementOperations>;
  element: Simple.Element;
  env: Environment;

  // TODO: ?
  expectConstructing(method: string): Simple.Element;
  expectOperations(method: string): ElementOperations;

  block(): Tracker;

  pushSimpleBlock(): Tracker;
  pushUpdatableBlock(): UpdatableTracker;
  pushBlockList(list: LinkedList<LinkedListNode & Bounds & Destroyable>): Tracker;
  popBlock(): Tracker;

  didAddDestroyable(d: Destroyable): void;
  didAppendBounds(bounds: Bounds): void;
}

export class NewElementBuilder implements ElementBuilder {
  public nextSibling: Option<Simple.Node>;
  public dom: DOMTreeConstruction;
  public updateOperations: DOMChanges;
  public constructing: Option<Simple.Element> = null;
  public operations: Option<ElementOperations> = null;
  public element: Simple.Element;
  public env: Environment;

  private elementStack = new Stack<Simple.Element>();
  private nextSiblingStack = new Stack<Option<Simple.Node>>();
  private blockStack = new Stack<Tracker>();

  protected defaultOperations: ElementOperations;

  static forInitialRender(env: Environment, parentNode: Simple.Element, nextSibling: Option<Simple.Node>) {
    return new this(env, parentNode, nextSibling);
  }

  static resume(env: Environment, tracker: Tracker, nextSibling: Option<Simple.Node>) {
    let parentNode = tracker.parentElement();

    let stack = new this(env, parentNode, nextSibling);
    stack.pushBlockTracker(tracker);

    return stack;
  }

  constructor(env: Environment, parentNode: Simple.Element, nextSibling: Option<Simple.Node>) {
    this.env = env;
    this.dom = env.getAppendOperations();
    this.updateOperations = env.getDOM();
    this.element = parentNode;
    this.nextSibling = nextSibling;

    this.defaultOperations = new SimpleElementOperations(env);

    this.pushSimpleBlock();
    this.elementStack.push(this.element);
    this.nextSiblingStack.push(this.nextSibling);
  }

  expectConstructing(method: string): Simple.Element {
    return expect(this.constructing, `${method} should only be called while constructing an element`);
  }

  expectOperations(method: string): ElementOperations {
    return expect(this.operations, `${method} should only be called while constructing an element`);
  }

  block(): Tracker {
    return expect(this.blockStack.current, "Expected a current block tracker");
  }

  popElement() {
    let { elementStack, nextSiblingStack }  = this;

    let topElement = elementStack.pop();
    nextSiblingStack.pop();
    // LOGGER.debug(`-> element stack ${this.elementStack.toArray().map(e => e.tagName).join(', ')}`);

    this.element = expect(elementStack.current, "can't pop past the last element");
    this.nextSibling = nextSiblingStack.current;

    return topElement;
  }

  pushSimpleBlock(): Tracker {
    let tracker = new SimpleBlockTracker(this.element);
    this.pushBlockTracker(tracker);
    return tracker;
  }

  pushUpdatableBlock(): UpdatableTracker {
    let tracker = new UpdatableBlockTracker(this.element);
    this.pushBlockTracker(tracker);
    return tracker;
  }

  private pushBlockTracker(tracker: Tracker, isRemote = false) {
    let current = this.blockStack.current;

    if (current !== null) {
      current.newDestroyable(tracker);

      if (!isRemote) {
        current.newBounds(tracker);
      }
    }

    this.blockStack.push(tracker);
    return tracker;
  }

  pushBlockList(list: LinkedList<LinkedListNode & Bounds & Destroyable>): Tracker {
    let tracker = new BlockListTracker(this.element, list);
    let current = this.blockStack.current;

    if (current !== null) {
      current.newDestroyable(tracker);
      current.newBounds(tracker);
    }

    this.blockStack.push(tracker);
    return tracker;
  }

  popBlock(): Tracker {
    this.block().finalize(this);
    return expect(this.blockStack.pop(), "Expected popBlock to return a block");
  }

  openElement(tag: string, _operations?: ElementOperations): Simple.Element {
    // workaround argument.length transpile of arg initializer
    let operations = _operations === undefined ? this.defaultOperations : _operations;
    let element = this.__openElement(tag);

    this.constructing = element;
    this.operations = operations;

    return element;
  }

  __openElement(tag: string): Simple.Element {
    return this.dom.createElement(tag, this.element);
  }

  flushElement() {
    let parent = this.element;
    let element = expect(this.constructing, `flushElement should only be called when constructing an element`);

    this.__flushElement(parent, element);

    this.constructing = null;
    this.operations = null;

    this.pushElement(element, null);
    this.didOpenElement(element);
  }

  __flushElement(parent: Simple.Element, constructing: Simple.Element) {
    this.dom.insertBefore(parent, constructing, this.nextSibling);
  }

  pushRemoteElement(element: Simple.Element, nextSibling: Option<Simple.Node> = null) {
    this.pushElement(element, nextSibling);

    let tracker = new RemoteBlockTracker(element);
    this.pushBlockTracker(tracker, true);
  }

  popRemoteElement() {
    this.popBlock();
    this.popElement();
  }

  protected pushElement(element: Simple.Element, nextSibling: Option<Simple.Node>) {
    this.element = element;
    this.elementStack.push(element);
    // LOGGER.debug(`-> element stack ${this.elementStack.toArray().map(e => e.tagName).join(', ')}`);

    this.nextSibling = nextSibling;
    this.nextSiblingStack.push(nextSibling);
  }

  didAddDestroyable(d: Destroyable) {
    this.block().newDestroyable(d);
  }

  didAppendBounds(bounds: Bounds): Bounds {
    this.block().newBounds(bounds);
    return bounds;
  }

  didAppendNode<T extends Simple.Node>(node: T): T {
    this.block().newNode(node);
    return node;
  }

  didOpenElement(element: Simple.Element): Simple.Element {
    this.block().openElement(element);
    return element;
  }

  willCloseElement() {
    this.block().closeElement();
  }

  appendText(string: string): Simple.Text {
    return this.didAppendNode(this.__appendText(string));
  }

  __appendText(text: string): Simple.Text {
    let { dom, element, nextSibling } = this;
    let node = dom.createTextNode(text);
    dom.insertBefore(element, node, nextSibling);
    return node;
  }

  appendNode(node: Simple.Node): Simple.Node {
    return this.didAppendNode(this.__appendNode(node));
  }

  __appendNode(node: Simple.Node): Simple.Node {
    this.dom.insertBefore(this.element, node, this.nextSibling);
    return node;
  }

  appendHTML(html: string): Bounds {
    return this.didAppendBounds(this.__appendHTML(html));
  }

  __appendHTML(html: string): Bounds {
    return this.dom.insertHTMLBefore(this.element, this.nextSibling, html);
  }

  appendTrustingDynamicContent(value: Opaque): DynamicContentWrapper {
    return new DynamicContentWrapper(this.__appendTrustingDynamicContent(value));
  }

  __appendTrustingDynamicContent(value: Opaque): DynamicContent {
    if (isNode(value)) {
      let node = this.appendNode(value);
      return new DynamicNodeContent(single(this.element, node), node);
    } else {
      let normalized: string;

      if (isEmpty(value)) {
        normalized = '';
      } else if (isSafeString(value)) {
        normalized = value.toHTML();
      } else if (isString(value)) {
        normalized = value;
      } else {
        normalized = String(value);
      }

      let bounds = this.appendHTML(normalized);
      return new DynamicTrustedHTMLContent(bounds, normalized);
    }
  }

  appendCautiousDynamicContent(value: Opaque): DynamicContentWrapper {
    return new DynamicContentWrapper(this.__appendCautiousDynamicContent(value));
  }

  __appendCautiousDynamicContent(value: Opaque): DynamicContent {
    if (isNode(value)) {
      let node = this.appendNode(value);
      return new DynamicNodeContent(single(this.element, node), node);
    } else if (isSafeString(value)) {
      let normalized = value.toHTML();
      let bounds = this.appendHTML(normalized);
      // let bounds = this.dom.insertHTMLBefore(this.element, this.nextSibling, normalized);
      return new DynamicHTMLContent(bounds, value);
    } else {
      let normalized: string;

      if (isEmpty(value)) {
        normalized = '';
      } else if (isString(value)) {
        normalized = value;
      } else {
        normalized = String(value);
      }

      let textNode = this.appendText(normalized);
      let bounds = single(this.element, textNode);

      return new DynamicTextContent(bounds, normalized);
    }
  }

  appendComment(string: string): Simple.Comment {
    return this.didAppendNode(this.__appendComment(string));
  }

  __appendComment(string: string): Simple.Comment {
    let { dom, element, nextSibling } = this;
    let node = dom.createComment(string);
    dom.insertBefore(element, node, nextSibling);
    return node;
  }

  setStaticAttribute(name: string, value: string) {
    this.expectOperations('setStaticAttribute').addStaticAttribute(this.expectConstructing('setStaticAttribute'), name, value);
  }

  setStaticAttributeNS(namespace: string, name: string, value: string) {
    this.expectOperations('setStaticAttributeNS').addStaticAttributeNS(this.expectConstructing('setStaticAttributeNS'), namespace, name, value);
  }

  setDynamicAttribute(name: string, reference: VersionedReference<string>, isTrusting: boolean) {
    this.expectOperations('setDynamicAttribute').addDynamicAttribute(this.expectConstructing('setDynamicAttribute'), name, reference, isTrusting);
  }

  setDynamicAttributeNS(namespace: string, name: string, reference: VersionedReference<string>, isTrusting: boolean) {
    this.expectOperations('setDynamicAttributeNS').addDynamicAttributeNS(this.expectConstructing('setDynamicAttributeNS'), namespace, name, reference, isTrusting);
  }

  closeElement() {
    this.willCloseElement();
    this.popElement();
  }
}

export interface Tracker extends DestroyableBounds {
  openElement(element: Simple.Element): void;
  closeElement(): void;
  newNode(node: Simple.Node): void;
  newBounds(bounds: Bounds): void;
  newDestroyable(d: Destroyable): void;
  finalize(stack: ElementBuilder): void;
}

export class SimpleBlockTracker implements Tracker {
  protected first: Option<FirstNode> = null;
  protected last: Option<LastNode> = null;
  protected destroyables: Option<Destroyable[]> = null;
  protected nesting = 0;

  constructor(private parent: Simple.Element){}

  destroy() {
    let { destroyables } = this;

    if (destroyables && destroyables.length) {
      for (let i=0; i<destroyables.length; i++) {
        destroyables[i].destroy();
      }
    }
  }

  parentElement() {
    return this.parent;
  }

  firstNode(): Option<Simple.Node> {
    return this.first && this.first.firstNode();
  }

  lastNode(): Option<Simple.Node> {
    return this.last && this.last.lastNode();
  }

  openElement(element: Element) {
    this.newNode(element);
    this.nesting++;
  }

  closeElement() {
    this.nesting--;
  }

  newNode(node: Node) {
    if (this.nesting !== 0) return;

    if (!this.first) {
      this.first = new First(node);
    }

    this.last = new Last(node);
  }

  newBounds(bounds: Bounds) {
    if (this.nesting !== 0) return;

    if (!this.first) {
      this.first = bounds;
    }

    this.last = bounds;
  }

  newDestroyable(d: Destroyable) {
    this.destroyables = this.destroyables || [];
    this.destroyables.push(d);
  }

  finalize(stack: ElementBuilder) {
    if (!this.first) {
      stack.appendComment('');
    }
  }
}

class RemoteBlockTracker extends SimpleBlockTracker {
  destroy() {
    super.destroy();

    clear(this);
  }
}

export interface UpdatableTracker extends Tracker {
  reset(env: Environment): Option<Simple.Node>;
}

export class UpdatableBlockTracker extends SimpleBlockTracker implements UpdatableTracker {
  reset(env: Environment): Option<Simple.Node> {
    let { destroyables } = this;

    if (destroyables && destroyables.length) {
      for (let i=0; i<destroyables.length; i++) {
        env.didDestroy(destroyables[i]);
      }
    }

    let nextSibling = clear(this);

    this.first = null;
    this.last = null;
    this.destroyables = null;
    this.nesting = 0;

    return nextSibling;
  }
}

class BlockListTracker implements Tracker {
  constructor(private parent: Simple.Element, private boundList: LinkedList<LinkedListNode & Bounds & Destroyable>) {
    this.parent = parent;
    this.boundList = boundList;
  }

  destroy() {
    this.boundList.forEachNode(node => node.destroy());
  }

  parentElement() {
    return this.parent;
  }

  firstNode(): Option<Simple.Node> {
    let head = this.boundList.head();
    return head && head.firstNode();
  }

  lastNode(): Option<Simple.Node> {
    let tail = this.boundList.tail();
    return tail && tail.lastNode();
  }

  openElement(_element: Element) {
    assert(false, 'Cannot openElement directly inside a block list');
  }

  closeElement() {
    assert(false, 'Cannot closeElement directly inside a block list');
  }

  newNode(_node: Node) {
    assert(false, 'Cannot create a new node directly inside a block list');
  }

  newBounds(_bounds: Bounds) {
  }

  newDestroyable(_d: Destroyable) {
  }

  finalize(_stack: ElementBuilder) {
  }
}
