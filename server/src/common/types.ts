import { Range as LSPRange } from 'vscode-languageserver/node';

// --- Re-export Location/Attribute bypass types ---
// Use 'any' for problematic types to bypass linter issues
// import { Location, Attribute } from 'parse5/dist/tree-adapters/default';
export type Location = any; // Bypass linter
export type Attribute = any; // Bypass linter

// +++ Added Type for Parser Result +++
export interface HtmlParsingResult {
    expressions: AureliaHtmlExpression[];
    elementTags: Array<{ 
        name: string; 
        startTagRange: Location; 
        endTagRange?: Location; // <<< Add optional endTagRange
    }>;
}
// ++++++++++++++++++++++++++++++++++

// --- Interfaces ---
export interface AureliaHtmlExpression {
    expression: string; // The raw expression string
    // Type can be interpolation or the specific binding command (bind, trigger, etc.)
    type: 'interpolation' | string; 
    htmlLocation: Location; // Use bypass type
    // Optional: Only relevant for attribute bindings
    attributeName?: string; // e.g., "value.bind"
    elementTagName?: string; // e.g., "my-input"
}

// Detailed mapping between HTML expression and virtual file representation
export interface DetailedMapping {
    htmlExpressionLocation: Location; // Use bypass type
    virtualBlockRange: { start: number; end: number }; // Range of the entire placeholder block (e.g., const ___expr_1 = (...);)
    virtualValueRange: { start: number; end: number }; // Range of the expression value inside the block
    // Type should mirror AureliaHtmlExpression.type
    type: 'interpolation' | string;
    attributeName?: string; // <<< ADDED: e.g., "value.bind"
    elementTagName?: string; // <<< ADDED: e.g., "my-input"
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
    elementTagLocations?: Array<{ name: string; startTagRange: Location; endTagRange?: Location }>;
}

// --- Added Type Definitions --- 
/**
 * Represents information about a discovered Aurelia component (element or attribute).
 */
export interface AureliaComponentInfo {
    uri: string;
    /** Is this a custom element or a custom attribute? */
    type: 'element' | 'attribute' | 'valueConverter' | 'bindingBehavior';
    /** The canonical name of the component (e.g., 'my-element' or 'my-attribute'). */
    name: string;
    /** List of bindable property names, if applicable. */
    bindables: AureliaBindableInfo[];
    /** The TypeScript class name, if known. */
    className?: string;
     /** Path to the source file containing the definition */
     sourceFile?: string;
}

// Interface for bindable property details
export interface AureliaBindableInfo {
    propertyName: string; // The name of the property in the TS class (e.g., myValue)
    attributeName?: string; // The explicit HTML attribute name if defined in @bindable (e.g., 'my-attribute')
}

/**
 * Map holding discovered Aurelia components in the project.
 * Key: component name (e.g., 'my-element', 'my-attribute')
 * Value: Component information
 */
export type AureliaProjectComponentMap = Map<string, AureliaComponentInfo>; 