import * as parse5 from 'parse5';
import { DefaultTreeAdapterTypes } from 'parse5';
import { AureliaHtmlExpression } from '../common/types';
import { log } from '../utils/logger';
import { isAureliaAttribute, calculateLocationFromOffset } from '../utils/utilities';

/**
 * Extracts Aurelia-specific expressions (interpolations and bindings) from HTML content.
 * Uses parse5 to traverse the HTML AST.
 */
export function extractExpressionsFromHtml(htmlContent: string): AureliaHtmlExpression[] {
    const expressions: AureliaHtmlExpression[] = [];
    const document = parse5.parse(htmlContent, { sourceCodeLocationInfo: true }) as DefaultTreeAdapterTypes.Document;
    const interpolationRegex = /\${([^}]*)}/g; // Match ${...}, allow empty {}

    const traverse = (node: DefaultTreeAdapterTypes.Node) => {
        log('debug', `[extractExpressions] Traversing node: ${node.nodeName}`);
        const hasLocation = !!node.sourceCodeLocation;

        if (!hasLocation) {
            log('debug', `[extractExpressions]   - Node ${node.nodeName} missing sourceCodeLocation, but will attempt to traverse children.`);
            // Proceed to child traversal below, but skip processing this node
        }

        // --- Process Node if Location Exists ---
        if (hasLocation) {
            // 1. Text Nodes for Interpolation: ${...}
            if (node.nodeName === '#text' && node.sourceCodeLocation) {
                const textNode = node as DefaultTreeAdapterTypes.TextNode;
                const textContent = textNode.value;
                log('debug', `[extractExpressions]   - Found #text node with content: "${textContent.substring(0, 50)}${textContent.length > 50 ? '...' : ''}"`);
                let match;
                interpolationRegex.lastIndex = 0;
                while ((match = interpolationRegex.exec(textContent)) !== null) {
                    log('debug', `[extractExpressions]     - REGEX MATCH FOUND: ${match[0]}`);
                    const expression = match[1];
                    const expressionStartOffset = textNode.sourceCodeLocation!.startOffset + match.index + 2;
                    const expressionEndOffset = expressionStartOffset + expression.length;
                    const startLoc = calculateLocationFromOffset(htmlContent, expressionStartOffset);
                    const endLoc = calculateLocationFromOffset(htmlContent, expressionEndOffset);
                    if (startLoc && endLoc) {
                        log('debug', `[extractExpressions] Creating INTERPOLATION mapping: expr='${expression}', startOffset=${expressionStartOffset}, endOffset=${expressionEndOffset}`);
                        expressions.push({
                            expression,
                            type: 'interpolation',
                            htmlLocation: {
                                startLine: startLoc.line,
                                startCol: startLoc.col,
                                endLine: endLoc.line,
                                endCol: endLoc.col,
                                startOffset: expressionStartOffset,
                                endOffset: expressionEndOffset,
                            },
                        });
                    }
                } // end while
            } // end if #text

            // 2. Element Attributes for Bindings: *.bind="..." etc.
            if ('attrs' in node && node.attrs && node.sourceCodeLocation) {
                const element = node as DefaultTreeAdapterTypes.Element;
                log('debug', `[extractExpressions]   - Checking attributes for <${element.tagName}>`);
                for (const attr of element.attrs) {
                    if (isAureliaAttribute(attr.name) && element.sourceCodeLocation?.attrs?.[attr.name]) {
                        log('debug', `[extractExpressions]     - Found Aurelia attribute: ${attr.name}`);
                        const attrLocation = element.sourceCodeLocation.attrs[attr.name];
                        const valueStartOffset = attrLocation.startOffset + attr.name.length + 2;
                        const valueEndOffset = attrLocation.endOffset - 1;
                        if (valueStartOffset <= valueEndOffset) { // Use <= to handle empty values
                            const expression = attr.value;
                            const startLoc = calculateLocationFromOffset(htmlContent, valueStartOffset);
                            const endLoc = calculateLocationFromOffset(htmlContent, valueEndOffset);
                            if (startLoc && endLoc) {
                                log('debug', `[extractExpressions] Creating BINDING mapping: attr='${attr.name}', expr='${expression}', startOffset=${valueStartOffset}, endOffset=${valueEndOffset}`);
                                expressions.push({
                                    expression: expression === '' ? 'true' : expression, // Handle boolean attribute case
                                    type: 'binding',
                                    htmlLocation: {
                                        startLine: startLoc.line,
                                        startCol: startLoc.col,
                                        endLine: endLoc.line,
                                        endCol: endLoc.col,
                                        startOffset: valueStartOffset,
                                        endOffset: valueEndOffset,
                                    },
                                });
                            }
                        }
                    } // end if isAureliaAttribute
                } // end for attr
            } // end if attrs

            // 4. Handle <template> content (Only if parent template has location)
            if (node.nodeName === 'template' && 'content' in node && node.content) {
                log('debug', `[extractExpressions]   - Traversing content of <template>`);
                traverse(node.content);
            }

        } // --- End of if(hasLocation) --- 

        // 3. Traverse Children (Always attempt)
        if (typeof (node as any).childNodes === 'object' && (node as any).childNodes !== null) {
            const childNodes = (node as any).childNodes as DefaultTreeAdapterTypes.Node[];
            if (childNodes.length > 0) {
                log('debug', `[extractExpressions]   - Traversing ${childNodes.length} children of ${node.nodeName}`);
                childNodes.forEach(traverse);
            }
        }
        else if ('content' in node && node.content && typeof node.content.childNodes === 'object' && node.content.childNodes !== null) {
            const childNodes = node.content.childNodes as DefaultTreeAdapterTypes.Node[];
            if (childNodes.length > 0) {
                log('debug', `[extractExpressions]   - Traversing ${childNodes.length} children of ${node.nodeName} <template> content`);
                childNodes.forEach(traverse);
            }
        }
    }; // end traverse function

    if (document.childNodes) {
        log('debug', `[extractExpressions] Starting traversal from ${document.childNodes.length} child nodes.`);
        document.childNodes.forEach(traverse);
    } else {
        log('warn', `[extractExpressions] Document parsing resulted in no child nodes.`);
    }

    expressions.sort((a, b) => a.htmlLocation.startOffset - b.htmlLocation.startOffset);
    log('debug', `[extractExpressions] Found ${expressions.length} expressions.`);
    return expressions;
} 