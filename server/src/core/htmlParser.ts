import * as parse5 from 'parse5';
import { DefaultTreeAdapterTypes } from 'parse5';
import { AureliaHtmlExpression, Location, HtmlParsingResult } from '../common/types';
import { log } from '../utils/logger';
import { isAureliaAttribute, calculateLocationFromOffset } from '../utils/utilities';

/**
 * Extracts Aurelia-specific expressions (interpolations and bindings) from HTML content.
 * Uses parse5 to traverse the HTML AST.
 */
export function extractExpressionsFromHtml(htmlContent: string): HtmlParsingResult {
    const expressions: AureliaHtmlExpression[] = [];
    const elementTags: HtmlParsingResult['elementTags'] = [];
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
                    log('debug', `[extractExpressions]       - Node Content: "${textContent.replace(/\n/g, '\\n')}"`);
                    log('debug', `[extractExpressions]       - Node Location: ${JSON.stringify(textNode.sourceCodeLocation)}`);
                    log('debug', `[extractExpressions]       - Match Index: ${match.index}`);
                    log('debug', `[extractExpressions]       - Found interpolation match: '${match[1]}' at index ${match.index} within text node.`);
                    const expression = match[1];

                    // +++ Count preceding newlines using regex +++
                    const textBeforeMatch = textContent.substring(0, match.index);
                    const newlineRegex = /(\r\n|\n)/g; // Re-use the regex
                    const newlineMatches = textBeforeMatch.match(newlineRegex); // Use match (returns array or null)
                    const newlineCount = newlineMatches ? newlineMatches.length : 0; // Count matches
                    log('debug', `[extractExpressions]       - Preceding newlines within node before index ${match.index}: ${newlineCount} (Regex)`);
                    // +++ End Count +++

                    // Adjust calculation: nodeStart + indexInNode + newlineAdjustment + ${ offset
                    const expressionStartOffset = textNode.sourceCodeLocation!.startOffset + match.index + newlineCount + 2;
                    log('debug', `[extractExpressions]       - Calculated expr Start Offset (with internal newline adjustment): ${expressionStartOffset}`);
                    const expressionEndOffset = expressionStartOffset + expression.length;
                    const startLoc = calculateLocationFromOffset(htmlContent, expressionStartOffset); // Use the potentially adjusted offset
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
                }
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
                        
                        // Extract binding command (bind, trigger, etc.)
                        const parts = attr.name.split('.');
                        const bindingCommand = parts.length > 1 ? parts.pop() : 'bind'; // Default to bind?

                        if (valueStartOffset <= valueEndOffset) { // Use <= to handle empty values
                            const expression = attr.value;
                            const startLoc = calculateLocationFromOffset(htmlContent, valueStartOffset);
                            const endLoc = calculateLocationFromOffset(htmlContent, valueEndOffset);
                            if (startLoc && endLoc) {
                                log('debug', `[extractExpressions] Creating BINDING mapping: attr='${attr.name}', expr='${expression}', startOffset=${valueStartOffset}, endOffset=${valueEndOffset}, element='${element.tagName}', command='${bindingCommand}'`);
                                expressions.push({
                                    expression: expression === '' ? 'true' : expression, // Handle boolean attribute case
                                    type: bindingCommand ?? 'bind', // Use extracted command
                                    htmlLocation: {
                                        startLine: startLoc.line,
                                        startCol: startLoc.col,
                                        endLine: endLoc.line,
                                        endCol: endLoc.col,
                                        startOffset: valueStartOffset,
                                        endOffset: valueEndOffset,
                                    },
                                    attributeName: attr.name, // Store full attribute name
                                    elementTagName: element.tagName // Store tag name
                                });
                            }
                        }
                    } // end if isAureliaAttribute
                } // end for attr

                if (element.sourceCodeLocation?.startTag) {
                    const startTagLoc = element.sourceCodeLocation.startTag;
                    const endTagLoc = element.sourceCodeLocation.endTag;

                    const startTagLocation: Location = {
                        startLine: startTagLoc.startLine,
                        startCol: startTagLoc.startCol,
                        endLine: startTagLoc.endLine,
                        endCol: startTagLoc.endCol,
                        startOffset: startTagLoc.startOffset,
                        endOffset: startTagLoc.endOffset
                    };
                    
                    let endTagLocation: Location | undefined = undefined;
                    if (endTagLoc) {
                        endTagLocation = {
                            startLine: endTagLoc.startLine,
                            startCol: endTagLoc.startCol,
                            endLine: endTagLoc.endLine,
                            endCol: endTagLoc.endCol,
                            startOffset: endTagLoc.startOffset,
                            endOffset: endTagLoc.endOffset
                        };
                    }

                    log('debug', `[extractExpressions]   - Found element tag: <${element.tagName}> at offset ${startTagLocation.startOffset}`);
                    elementTags.push({ 
                        name: element.tagName, 
                        startTagRange: startTagLocation, 
                        endTagRange: endTagLocation
                    });
                }

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
    elementTags.sort((a, b) => a.startTagRange.startOffset - b.startTagRange.startOffset);
    log('debug', `[extractExpressions] Found ${expressions.length} expressions and ${elementTags.length} element tags.`);
    return { expressions, elementTags };
} 