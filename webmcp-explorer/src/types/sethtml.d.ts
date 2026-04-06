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

interface Sanitizer {
  // eslint-disable-next-line @typescript-eslint/no-misused-new
  new (config?: SanitizerConfig): Sanitizer;
}

interface SetHTMLOptions {
  sanitizer?: Sanitizer | SanitizerConfig | 'default';
}

interface Element {
  setHTML(input: string, options?: SetHTMLOptions): void;
}
