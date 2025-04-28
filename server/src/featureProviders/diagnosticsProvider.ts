import * as ts from 'typescript';
import {
    Diagnostic,
    DiagnosticSeverity,
    Range as LSPRange,
    Connection
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, AureliaProjectComponentMap } from '../common/types'; 
import { serverSettings } from '../common/settings';
import { log } from '../utils/logger';

// Helper function to find the deepest node at a specific position
function findNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  function find(node: ts.Node): ts.Node | undefined {
    if (position >= node.getStart(sourceFile) && position < node.getEnd()) {
      let betterNode: ts.Node | undefined = node; // Default to current node
      // Check children to see if a narrower node exists
      ts.forEachChild(node, (child) => {
        const foundChild = find(child);
        if (foundChild) {
          betterNode = foundChild;
        }
      });
      return betterNode;
    }
    return undefined;
  }
  return find(sourceFile);
}

/**
 * Calculates and sends diagnostics for an Aurelia HTML file.
 */
export function updateDiagnostics(
    htmlUriString: string, 
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    connection: Connection,
    aureliaProjectComponents: AureliaProjectComponentMap
): void { 
    if (!serverSettings.diagnostics.enable) {
        log('debug', '[updateDiagnostics] Diagnostics disabled via settings.');
        connection.sendDiagnostics({ uri: htmlUriString, diagnostics: [] });
        return;
    }
    
    const docInfo = aureliaDocuments.get(htmlUriString); 
    const document = documents.get(htmlUriString);

    if (!docInfo || !document || !languageService) {
        log('debug', `[updateDiagnostics] Skipping diagnostics for ${htmlUriString} - no docInfo, document, or LS.`);
        connection.sendDiagnostics({ uri: htmlUriString, diagnostics: [] });
        return;
    }
    
    const virtualUriToUse = docInfo.virtualUri; 
    const virtualPath = URI.parse(virtualUriToUse).fsPath;
    log('debug', `[updateDiagnostics] Getting diagnostics for virtual path: ${virtualPath}`);
    
    let allVirtualDiagnostics: ts.Diagnostic[] = [];
    try {
        const semanticDiagnostics = languageService.getSemanticDiagnostics(virtualPath);
        const syntacticDiagnostics = languageService.getSyntacticDiagnostics(virtualPath);
        allVirtualDiagnostics = [...semanticDiagnostics, ...syntacticDiagnostics];
    } catch (e) {
        log('error', `[updateDiagnostics] Error getting TS diagnostics for ${virtualPath}`, e);
        // Send empty diagnostics on error?
        connection.sendDiagnostics({ uri: htmlUriString, diagnostics: [] });
        return;
    }

    const htmlDiagnostics: Diagnostic[] = [];

    for (const virtualDiag of allVirtualDiagnostics) {
        if (virtualDiag.start === undefined || virtualDiag.length === undefined) continue;

        const virtualDiagStart = virtualDiag.start;
        const virtualDiagEnd = virtualDiag.start + virtualDiag.length;
        let mapped = false;

        for (const mapping of docInfo.mappings) {
            if (Math.max(virtualDiagStart, mapping.virtualValueRange.start) < Math.min(virtualDiagEnd, mapping.virtualValueRange.end)) {
                // Map the virtual diagnostic range back to the HTML range
                let accumulatedOffsetDeltaBeforeStart = 0;
                for (const transform of mapping.transformations) {
                    if (transform.virtualRange.end <= virtualDiagStart) {
                        accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                    }
                }
                const baseHtmlOffset = mapping.htmlExpressionLocation.startOffset;
                const baseVirtualOffset = mapping.virtualValueRange.start;
                const htmlDiagStartOffset = baseHtmlOffset + (virtualDiagStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
                
                // Map end offset similarly
                 let accumulatedOffsetDeltaBeforeEnd = 0;
                 for (const transform of mapping.transformations) {
                    if (transform.virtualRange.end <= virtualDiagEnd) {
                        accumulatedOffsetDeltaBeforeEnd += transform.offsetDelta;
                    }
                }
                 const htmlDiagEndOffset = baseHtmlOffset + (virtualDiagEnd - baseVirtualOffset) - accumulatedOffsetDeltaBeforeEnd;

                // Clamp and validate
                const htmlExprStart = mapping.htmlExpressionLocation.startOffset;
                const htmlExprEnd = mapping.htmlExpressionLocation.endOffset;
                const clampedHtmlStart = Math.max(htmlDiagStartOffset, htmlExprStart);
                let clampedHtmlEnd = Math.min(htmlDiagEndOffset, htmlExprEnd);
                clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);

                 if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart) {
                    const htmlRange = LSPRange.create(
                        document.positionAt(clampedHtmlStart),
                        document.positionAt(clampedHtmlEnd)
                    );

                    htmlDiagnostics.push({
                        severity: mapDiagnosticSeverity(virtualDiag.category),
                        range: htmlRange,
                        message: ts.flattenDiagnosticMessageText(virtualDiag.messageText, '\n'),
                        source: 'Aurelia Linter (via TS)',
                        code: virtualDiag.code,
                    });
                    mapped = true;
                    // Don't break, diagnostic might span multiple mappings conceptually?
                 } else {
                      log('warn', `[updateDiagnostics] Skipping diagnostic due to invalid mapped range: HTML[${clampedHtmlStart}-${clampedHtmlEnd}] from Virtual[${virtualDiagStart}-${virtualDiagEnd}]`);
                 }
            }
        }
        if (!mapped) {
             log('debug', `[updateDiagnostics] Diagnostic could not be mapped to specific HTML expression: ${ts.flattenDiagnosticMessageText(virtualDiag.messageText, '\n')} (Code: ${virtualDiag.code})`);
        }
    }

    // +++ START: Custom Aurelia Bindable Type Checking +++
    const typeChecker = languageService.getProgram()?.getTypeChecker();
    if (typeChecker && docInfo.vmFsPath) { // Ensure we have a type checker and view model context
        log('info', `[updateDiagnostics] Performing custom bindable type checks for ${htmlUriString}`);
        
        for (const mapping of docInfo.mappings) {
            if (mapping.type !== 'interpolation') { // Check if it's any kind of attribute binding 
                try {
                    // Use data directly from mapping
                    const attributeNameWithCommand = mapping.attributeName; // e.g., value.bind
                    const elementTagName = mapping.elementTagName;

                    if (!attributeNameWithCommand || !elementTagName) {
                        log('warn', `[updateDiagnostics] Skipping type check: Mapping missing attribute/element name. Type: ${mapping.type}`);
                        continue;
                    }
                    
                    // Extract attribute name without the command
                    const parts = attributeNameWithCommand.split('.');
                    const attributeName = parts[0]; // Take the part before the first dot
                    const bindingCommand = mapping.type; // Already extracted by parser

                    const expressionRange = LSPRange.create(document.positionAt(mapping.htmlExpressionLocation.startOffset), document.positionAt(mapping.htmlExpressionLocation.endOffset));
                    const expressionText = document.getText(expressionRange); 
                    
                    // Find component definition in project map
                    const componentInfo = aureliaProjectComponents.get(elementTagName);
                    if (!componentInfo || !componentInfo.uri) {
                        log('debug', `[updateDiagnostics] Skipping type check: Component info not found for <${elementTagName}>`);
                        continue;
                    }

                    // Get Bindable Property Type from Component's TS file
                    const componentSourceFile = languageService.getProgram()?.getSourceFile(URI.parse(componentInfo.uri).fsPath);
                    if (!componentSourceFile) {
                        log('warn', `[updateDiagnostics] Skipping type check: Could not get source file for component ${elementTagName}`);
                        continue;
                    }
                    
                    let bindablePropertyType: ts.Type | undefined;
                    // Find class declaration, then property declaration, then get its type
                    // (Simplified logic - needs robust implementation)
                    ts.forEachChild(componentSourceFile, node => {
                        if (ts.isClassDeclaration(node)) { // TODO: Match actual class name if available
                            node.members.forEach(member => {
                                if ((ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) && member.name.getText(componentSourceFile) === attributeName) {
                                    const symbol = typeChecker.getSymbolAtLocation(member.name);
                                    if (symbol) {
                                        bindablePropertyType = typeChecker.getTypeOfSymbolAtLocation(symbol, member.name);
                                    }
                                }
                            });
                        }
                    });

                    if (!bindablePropertyType) {
                        log('debug', `[updateDiagnostics] Skipping type check: Could not find type for bindable property '${attributeName}' on <${elementTagName}>`);
                        continue;
                    }

                    // Get HTML Expression Type from Virtual File
                    const virtualSourceFile = languageService.getProgram()?.getSourceFile(virtualPath);
                    if (!virtualSourceFile) {
                        log('warn', '[updateDiagnostics] Skipping type check: Could not get virtual source file.');
                        continue;
                    }
                    const node = findNodeAtPosition(virtualSourceFile, mapping.virtualValueRange.start); // Need helper function findNodeAtPosition
                    if (!node) {
                        log('debug', `[updateDiagnostics] Skipping type check: Could not find node in virtual file at position ${mapping.virtualValueRange.start}`);
                        continue;
                    }
                    // Use getTypeAtLocation as it accepts ts.Node
                    const expressionType = typeChecker.getTypeAtLocation(node);
                    // TODO: Check if getTypeAtLocation is sufficient or if we need to narrow the node type first
                    // const expressionType = typeChecker.getContextualType(node as ts.Expression) ?? typeChecker.getTypeAtLocation(node);
                    
                    if (!expressionType) {
                         log('debug', `[updateDiagnostics] Skipping type check: Could not determine type for expression '${expressionText}'`);
                        continue;
                    }

                    // Check Type Assignability 
                    let isAssignable = false;
                    let checkDirection: 'toView' | 'fromView' | 'both' | 'none' = 'none';

                    switch (bindingCommand) {
                        case 'bind':
                        case 'to-view':
                            isAssignable = typeChecker.isTypeAssignableTo(expressionType, bindablePropertyType);
                            checkDirection = 'toView';
                            break;
                        case 'from-view':
                            isAssignable = typeChecker.isTypeAssignableTo(bindablePropertyType, expressionType);
                            checkDirection = 'fromView';
                            break;
                        case 'two-way':
                            // Check both directions for two-way binding
                            isAssignable = typeChecker.isTypeAssignableTo(expressionType, bindablePropertyType) && 
                                           typeChecker.isTypeAssignableTo(bindablePropertyType, expressionType);
                            checkDirection = 'both';
                            break;
                        // case 'trigger':
                        // case 'delegate':
                        // case 'call': // Event/Call bindings usually expect functions, different check needed
                        //    // TODO: Implement checks for event/call bindings (e.g., check if expressionType is a function signature)
                        //    isAssignable = true; // Placeholder: Assume true for now
                        //    break;
                        default:
                            // For unknown or non-type-checked bindings, assume okay for now
                            log('debug', `[updateDiagnostics] Skipping type check for unhandled binding command: ${bindingCommand}`);
                            isAssignable = true; 
                            break;
                    }
                    

                    if (!isAssignable && checkDirection !== 'none') {
                        const bindableTypeString = typeChecker.typeToString(bindablePropertyType);
                        const expressionTypeString = typeChecker.typeToString(expressionType);
                        let message = '';
                        if (checkDirection === 'toView' || (checkDirection === 'both' && !typeChecker.isTypeAssignableTo(expressionType, bindablePropertyType))) {
                            message = `Type '${expressionTypeString}' is not assignable to bindable property '${attributeName}' of type '${bindableTypeString}'.`;
                        } else if (checkDirection === 'fromView' || (checkDirection === 'both' && !typeChecker.isTypeAssignableTo(bindablePropertyType, expressionType))) {
                            message = `Bindable property '${attributeName}' of type '${bindableTypeString}' is not assignable to expression of type '${expressionTypeString}'.`;
                        }

                        if (message) {
                            const htmlRange = LSPRange.create(
                                document.positionAt(mapping.htmlExpressionLocation.startOffset),
                                document.positionAt(mapping.htmlExpressionLocation.endOffset)
                            );
                            htmlDiagnostics.push({
                                severity: DiagnosticSeverity.Error,
                                range: htmlRange,
                                message: message,
                                source: 'Aurelia Type Check',
                            });
                            log('info', `[updateDiagnostics] Added type mismatch diagnostic for '${attributeName}' on <${elementTagName}> (${expressionTypeString} <=> ${bindableTypeString}, Command: ${bindingCommand})`);
                        }
                    }

                } catch (e) {
                     log('error', `[updateDiagnostics] Error during custom type check for mapping: ${JSON.stringify(mapping)}`, e);
                }
            }
        }
    }
    // +++ END: Custom Aurelia Bindable Type Checking +++

    connection.sendDiagnostics({ uri: htmlUriString, diagnostics: htmlDiagnostics });
    log('info', `[updateDiagnostics] Sent ${htmlDiagnostics.length} diagnostics for ${htmlUriString}`);
}

/**
 * Maps TS DiagnosticCategory to LSP DiagnosticSeverity
 */
function mapDiagnosticSeverity(category: ts.DiagnosticCategory): DiagnosticSeverity {
    switch (category) {
        case ts.DiagnosticCategory.Error: return DiagnosticSeverity.Error;
        case ts.DiagnosticCategory.Warning: return DiagnosticSeverity.Warning;
        case ts.DiagnosticCategory.Message: return DiagnosticSeverity.Information;
        case ts.DiagnosticCategory.Suggestion: return DiagnosticSeverity.Hint;
        default: return DiagnosticSeverity.Information;
    }
} 