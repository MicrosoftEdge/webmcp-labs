// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Minimal type declarations for the HTML Sanitizer API.
 * Available in Chrome/Edge 146+ and Firefox 148+.
 *
 * Remove this file once TypeScript ships these types in lib.dom.d.ts.
 * Track: https://github.com/microsoft/TypeScript-DOM-lib-generator/issues
 */

interface SanitizerConfig {
  elements?: string[];
  removeElements?: string[];
  replaceWithChildrenElements?: string[];
  attributes?: string[];
  removeAttributes?: string[];
}

declare class Sanitizer {
  constructor(config?: SanitizerConfig);
  allowElement(element: string): void;
  allowAttribute(attribute: string): void;
  removeElement(element: string): void;
  removeAttribute(attribute: string): void;
  get(): SanitizerConfig;
}

interface SetHTMLOptions {
  sanitizer?: Sanitizer | SanitizerConfig | 'default';
}

interface Element {
  setHTML(input: string, options?: SetHTMLOptions): void;
}
