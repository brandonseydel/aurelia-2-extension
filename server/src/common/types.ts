import { Range as LSPRange } from 'vscode-languageserver/node';

// --- Re-export Location/Attribute bypass types ---
// Use 'any' for problematic types to bypass linter issues
// import { Location, Attribute } from 'parse5/dist/tree-adapters/default';
export type Location = any; // Bypass linter
export type Attribute = any; // Bypass linter

// --- Interfaces ---
export interface AureliaHtmlExpression {
    expression: string; // The raw expression string
    type: 'interpolation' | 'binding';
    htmlLocation: Location; // Use bypass type
}

// Detailed mapping between HTML expression and virtual file representation
export interface DetailedMapping {
    htmlExpressionLocation: Location; // Use bypass type
    virtualBlockRange: { start: number; end: number }; // Range of the entire placeholder block (e.g., const ___expr_1 = (...);)
    virtualValueRange: { start: number; end: number }; // Range of the expression value inside the block
    type: 'interpolation' | 'binding';
    transformations: Array<{
        htmlRange: { start: number; end: number };     // Range of original identifier in HTML
        virtualRange: { start: number; end: number }; // Range of transformed identifier (_this.ident) in Virtual TS
        offsetDelta: number; // Change in offset start position (usually 6 for `_this.`)
    }>;
}

// Information stored per HTML document
export interface AureliaDocumentInfo {
    virtualUri: string;
    mappings: DetailedMapping[];
    vmClassName: string; // ViewModel class name
    vmFsPath: string; // ViewModel file system path
} 