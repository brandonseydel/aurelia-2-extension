import * as ts from 'typescript';
import {
    HoverParams,
    Hover,
    MarkedString,
    MarkupContent,
    MarkupKind,
    Range as LSPRange
} from 'vscode-languageserver/node';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping, AureliaProjectComponentMap, AureliaComponentInfo } from '../common/types'; 
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';
import { getWordRangeAtPosition } from '../utils/utilities';
import * as parse5 from 'parse5';
import { DefaultTreeAdapterMap } from 'parse5';

/**
 * Helper to find the position of a class or property declaration.
 */
function findDeclarationPosition(name: string, type: 'class' | 'property', containingClass: string | undefined, sourceFile: ts.SourceFile): ts.TextSpan | undefined {
    let foundSpan: ts.TextSpan | undefined = undefined;

    function visit(node: ts.Node) {
        if (foundSpan) return; // Stop searching if found

        if (type === 'class' && ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === name) {
            if (node.name) {
                foundSpan = { start: node.name.getStart(sourceFile), length: node.name.getEnd() - node.name.getStart(sourceFile) };
            }
            return;
        }
        // If searching for property, ensure we are inside the correct class
        if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === containingClass) {
            for (const member of node.members) {
                if (type === 'property' && (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name?.getText(sourceFile) === name) {
                    if (member.name) {
                        foundSpan = { start: member.name.getStart(sourceFile), length: member.name.getEnd() - member.name.getStart(sourceFile) };
                    }
                    return; // Stop searching members
                }
            }
             return; 
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return foundSpan;
}

/**
 * Handles hover requests.
 */
export async function handleHoverRequest(
    params: HoverParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap,
    program: ts.Program | undefined
): Promise<Hover | undefined> {
    const textDocument = documents.get(params.textDocument.uri);
    if (!textDocument) return undefined;

    const uri = params.textDocument.uri;
    const offset = textDocument.offsetAt(params.position);
    program ??= languageService.getProgram(); // Ensure program is available

    if (!program) {
        log('warn', '[onHover] Could not get TS Program object.');
        return undefined;
    }

    // --- HTML File Logic --- 
    if (uri.endsWith('.html')) {
        const docInfo = aureliaDocuments.get(uri);
        // TODO: Add on-demand generation if missing?
        if (!docInfo) {
            log('warn', `[onHover] No AureliaDocumentInfo for ${uri}. Hover info may be limited.`);
            // Allow proceeding for basic HTML tags/attributes even without docInfo
        }

        // --- Find Active Mapping --- 
        let activeMapping: DetailedMapping | undefined;
        if (docInfo) {
            for (const mapping of docInfo.mappings) {
                const checkStart = mapping.type === 'interpolation' ? mapping.htmlExpressionLocation.startOffset - 2 : mapping.htmlExpressionLocation.startOffset;
                const checkEnd = mapping.type === 'interpolation' ? mapping.htmlExpressionLocation.endOffset + 1 : mapping.htmlExpressionLocation.endOffset;
                if (checkStart <= offset && offset <= checkEnd) {
                    activeMapping = mapping;
                    break;
                }
            }
        }

        // --- Branch 1: Hover INSIDE an Aurelia expression --- 
        if (activeMapping && docInfo) {
            log('debug', `[onHover] Offset ${offset} is inside mapped expression.`);
            let virtualHoverOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
            log('debug', `[onHover] Mapped HTML Offset: ${offset} to Virtual Offset: ${virtualHoverOffset} in ${docInfo.virtualUri} for TS Query`);

            const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
            let quickInfo: ts.QuickInfo | undefined;
            try {
                quickInfo = languageService.getQuickInfoAtPosition(virtualFsPath, virtualHoverOffset);
            } catch (e) {
                log('error', `[onHover] Error getting quickInfo at ${virtualHoverOffset}: ${e}`);
                return undefined;
            }

            if (!quickInfo || !quickInfo.displayParts) {
                log('debug', '[onHover] TS returned no QuickInfo for expression.');
                return undefined;
            }

            // --- Map TS Result Span back to HTML Range --- 
            const originVirtualSpan = quickInfo.textSpan;
            const virtualSpanStart = originVirtualSpan.start;
            const virtualSpanEnd = originVirtualSpan.start + originVirtualSpan.length;
            let htmlRange: LSPRange | undefined;
            try {
                const containingTransformation = activeMapping.transformations.find(t => 
                    virtualSpanStart >= t.virtualRange.start && virtualSpanStart < t.virtualRange.end
                );
                if (containingTransformation) {
                    htmlRange = LSPRange.create(
                        textDocument.positionAt(containingTransformation.htmlRange.start),
                        textDocument.positionAt(containingTransformation.htmlRange.end)
                    );
                } else {
                    let accumulatedOffsetDeltaBeforeStart = 0;
                    for (const transform of activeMapping.transformations) {
                        if (transform.virtualRange.end <= virtualSpanStart) { 
                            accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                        }
                    }
                    const baseHtmlOffset = activeMapping.htmlExpressionLocation.startOffset;
                    const baseVirtualOffset = activeMapping.virtualValueRange.start;
                    const htmlStartOffset = baseHtmlOffset + (virtualSpanStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
                    const spanLength = virtualSpanEnd - virtualSpanStart; 
                    const htmlEndOffset = htmlStartOffset + spanLength;
                    const htmlExprStart = activeMapping.htmlExpressionLocation.startOffset;
                    const htmlExprEnd = activeMapping.htmlExpressionLocation.endOffset;
                    const clampedHtmlStart = Math.max(htmlStartOffset, htmlExprStart);
                    let clampedHtmlEnd = Math.min(htmlEndOffset, htmlExprEnd);
                    clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);
                    if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart) {
                        htmlRange = LSPRange.create(
                            textDocument.positionAt(clampedHtmlStart),
                            textDocument.positionAt(clampedHtmlEnd)
                        );
                    }
                }
            } catch (e) {
                log('error', `[onHover] Error during transformation-based span mapping: ${e}`);
            }
            // --- End Mapping ---

            const contents: MarkedString[] = [];
            const typeString = ts.displayPartsToString(quickInfo.displayParts);
            contents.push({ language: 'typescript', value: typeString });
            if (quickInfo.documentation && quickInfo.documentation.length > 0) {
              contents.push(ts.displayPartsToString(quickInfo.documentation));
            }
            log('debug', `[onHover] Expression Hover: Providing hover info for range: ${JSON.stringify(htmlRange)}`);
            return { contents, range: htmlRange };
        }
        // --- Branch 2: Hover OUTSIDE an Aurelia expression (Tags/Attributes) --- 
        else {
            log('debug', `[onHover] Offset ${offset} is outside expression. Analyzing HTML structure...`);
            let targetTagName: string | undefined;
            let targetAttributeName: string | undefined;
            let targetNode: parse5.DefaultTreeAdapterMap['element'] | undefined;
            let hoverAttributeRange: LSPRange | undefined; // Specific range for the attribute name

            try {
                const documentText = textDocument.getText();
                const fragment = parse5.parseFragment(documentText, { sourceCodeLocationInfo: true });
                let found = false;

                 // findNodeAtOffset function (similar to definitionProvider)
                 const findNodeAtOffset = (nodes: DefaultTreeAdapterMap['node'][] | undefined): boolean => {
                    if (!nodes) return false;
                    for (const node of nodes) {
                        const nodeLoc = node.sourceCodeLocation;
                        if (!nodeLoc) continue;
                        const start = nodeLoc.startOffset;
                        const end = nodeLoc.endOffset;

                        if (offset >= start && offset <= end) {
                            if ('childNodes' in node) {
                                if (findNodeAtOffset((node as DefaultTreeAdapterMap['element']).childNodes)) {
                                    return true; 
                                }
                            }
                            
                            if (node.nodeName !== '#text' && node.nodeName !== '#comment' && 'tagName' in node) {
                                const elementNode = node as parse5.DefaultTreeAdapterMap['element'];
                                const elementLoc = nodeLoc as parse5.Token.ElementLocation; 

                                if (elementLoc.startTag && offset >= (elementLoc.startTag.startOffset + 1) && offset <= (elementLoc.startTag.startOffset + 1 + elementNode.tagName.length)) {
                                    targetNode = elementNode;
                                    targetTagName = elementNode.tagName;
                                    return true; 
                                }

                                if (elementLoc.attrs) {
                                     for (const attr of elementNode.attrs) {
                                        const attrLoc = elementLoc.attrs[attr.name];
                                        if (attrLoc && offset >= attrLoc.startOffset && offset <= attrLoc.endOffset) {
                                            const nameEndOffset = attrLoc.startOffset + attr.name.length;
                                            if (offset <= nameEndOffset) {
                                                targetNode = elementNode; 
                                                targetAttributeName = attr.name;
                                                // Store the precise range of the attribute name for hover
                                                hoverAttributeRange = LSPRange.create(
                                                    textDocument.positionAt(attrLoc.startOffset),
                                                    textDocument.positionAt(nameEndOffset)
                                                );
                                                return true; 
                                            }
                                        }
                                    }
                                }
                            }
                            return false; 
                        }
                    }
                    return false;
                };

                found = findNodeAtOffset(fragment.childNodes);

                let hoverContent: MarkupContent | undefined;
                let hoverRange: LSPRange | undefined = hoverAttributeRange; // Use specific attr range if found

                // --- Handle Tag Hover ---
                if (targetTagName && targetNode && !targetAttributeName) {
                    log('debug', `[onHover] Found target element: ${targetTagName}`);
                    const componentInfo = aureliaProjectComponents.get(targetTagName);
                    if (componentInfo?.type === 'element' && componentInfo.uri && componentInfo.sourceFile && componentInfo.className) {
                         const sourceFile = program.getSourceFile(componentInfo.sourceFile);
                         if (sourceFile) {
                            const classPosSpan = findDeclarationPosition(componentInfo.className, 'class', undefined, sourceFile);
                            if (classPosSpan) {
                                const quickInfo = languageService.getQuickInfoAtPosition(componentInfo.sourceFile, classPosSpan.start);
                                if (quickInfo) {
                                    const markdownLines: string[] = [];
                                    markdownLines.push(`**${targetTagName}** (element)`);
                                    markdownLines.push(`*Class:* \`${componentInfo.className}\``);
                                    const displayParts = ts.displayPartsToString(quickInfo.displayParts);
                                    if (displayParts && displayParts !== componentInfo.className) { // Avoid redundant class name
                                         markdownLines.push('---');
                                         markdownLines.push('```typescript\n' + displayParts + '\n```');
                                    }
                                    if (quickInfo.documentation?.length) {
                                        markdownLines.push('---');
                                        markdownLines.push(ts.displayPartsToString(quickInfo.documentation));
                                    }

                                    // <<< RESTORE BINDABLES LIST >>>
                                    if (componentInfo.bindables && componentInfo.bindables.length > 0) {
                                        markdownLines.push('\n---\n**Bindables:**');
                                        componentInfo.bindables.forEach(bindableInfo => {
                                            // Use propertyName, fallback to attributeName if needed for display?
                                            // Let's primarily show the property name developers use in the VM.
                                            const nameToShow = bindableInfo.propertyName;
                                            const attributeName = bindableInfo.attributeName ?? '(auto)'; // Indicate if name is inferred
                                            markdownLines.push(`- \`${nameToShow}\` (attribute: \`${attributeName}\`)`);
                                            // TODO: Could add type info here later by looking up property in TS
                                        });
                                    }
                                    // <<< END RESTORE BINDABLES LIST >>>

                                    hoverContent = { kind: MarkupKind.Markdown, value: markdownLines.join('  \n') };
                                }
                            }
                         }
                         // Set hover range for tag name
                         const elementLoc = targetNode.sourceCodeLocation as parse5.Token.ElementLocation;
                         if (!hoverRange && elementLoc?.startTag) {
                            const tagStartOffset = elementLoc.startTag.startOffset + 1;
                            hoverRange = LSPRange.create(
                                textDocument.positionAt(tagStartOffset),
                                textDocument.positionAt(tagStartOffset + targetTagName.length)
                            );
                         }
                    }
                } 
                // --- Handle Attribute Hover ---
                else if (targetAttributeName && targetNode) {
                    log('debug', `[onHover] Found target attribute: ${targetAttributeName} on element <${targetNode.tagName}>`);
                    const baseAttributeName = targetAttributeName.split('.')[0];
                    let targetPropertyName: string | undefined;
                    let quickInfo: ts.QuickInfo | undefined;
                    let componentInfo: AureliaComponentInfo | undefined;
                    let sourceFilePath: string | undefined;
                    let positionSpan: ts.TextSpan | undefined;
                    let header = `**${baseAttributeName}**`;

                    // Priority 1: Custom Attribute?
                    componentInfo = aureliaProjectComponents.get(baseAttributeName);
                    if (componentInfo?.type === 'attribute' && componentInfo.uri && componentInfo.sourceFile && componentInfo.className) {
                        header += ' (custom-attribute)';
                        sourceFilePath = componentInfo.sourceFile;
                        const sourceFile = program.getSourceFile(sourceFilePath);
                        if(sourceFile) {
                            positionSpan = findDeclarationPosition(componentInfo.className, 'class', undefined, sourceFile);
                        }
                    } else {
                        // Priority 2: Bindable property?
                        componentInfo = aureliaProjectComponents.get(targetNode.tagName); // Element info
                        if (componentInfo?.type === 'element' && componentInfo.bindables && componentInfo.sourceFile && componentInfo.className) {
                             const bindableInfo = componentInfo.bindables.find(b => 
                                 b.propertyName === baseAttributeName || b.attributeName === baseAttributeName
                             );
                             if (bindableInfo) {
                                 header += ` (bindable on \`${targetNode.tagName}\`)`;
                                 targetPropertyName = bindableInfo.propertyName;
                                 sourceFilePath = componentInfo.sourceFile;
                                 const sourceFile = program.getSourceFile(sourceFilePath);
                                 if(sourceFile) {
                                     positionSpan = findDeclarationPosition(targetPropertyName, 'property', componentInfo.className, sourceFile);
                                 }
                             }
                        }
                    }

                    // Get QuickInfo if we found a definition location
                    if (sourceFilePath && positionSpan) {
                         try {
                            quickInfo = languageService.getQuickInfoAtPosition(sourceFilePath, positionSpan.start);
                         } catch(e) {
                             log('error', `[onHover] Error getting quickInfo for ${targetAttributeName}: ${e}`);
                         }
                    }

                    // Construct hover content if info found
                    if (quickInfo) {
                        const markdownLines: string[] = [header];
                         const displayParts = ts.displayPartsToString(quickInfo.displayParts);
                         if (displayParts) {
                             markdownLines.push('---');
                             markdownLines.push('```typescript\n' + displayParts + '\n```');
                         }
                         if (quickInfo.documentation?.length) {
                             markdownLines.push('---');
                             markdownLines.push(ts.displayPartsToString(quickInfo.documentation));
                         }
                         hoverContent = { kind: MarkupKind.Markdown, value: markdownLines.join('  \n') };
                    } else if (componentInfo) { // Basic info if no quickinfo
                         const markdownLines: string[] = [header];
                         if (componentInfo.className) markdownLines.push(`*Class:* \`${componentInfo.className}\``);
                         if (componentInfo.sourceFile) markdownLines.push(`*From:* \`${path.basename(componentInfo.sourceFile)}\``);
                          hoverContent = { kind: MarkupKind.Markdown, value: markdownLines.join('  \n') };
                    }
                }

                // Return Hover if content was generated
                if (hoverContent) {
                    // Use attribute range if available, otherwise fallback
                     hoverRange = hoverRange ?? getWordRangeAtPosition(textDocument, params.position) ?? LSPRange.create(params.position, params.position);
                    log('info', `[onHover] Providing hover for HTML tag/attribute.`);
                    return { contents: hoverContent, range: hoverRange };
                }

            } catch (error) {
                log('error', `[onHover] Error parsing HTML for tag/attribute hover: ${error}`);
            }

            log('debug', '[onHover] No hover info generated for outside expression.');
            return undefined;
        }
    }
    // --- TS File Logic (Basic) ---
    else if (uri.endsWith('.ts')) {
        log('debug', `[onHover] Request inside TS file: ${uri}. Using default TS hover.`);
        let quickInfo: ts.QuickInfo | undefined;
        try {
            quickInfo = languageService.getQuickInfoAtPosition(URI.parse(uri).fsPath, offset);
        } catch (e) {
             log('error', `[onHover] Error getting quickInfo for TS file: ${e}`);
            return undefined;
        }

        if (!quickInfo || !quickInfo.displayParts) return undefined;

        const contents: MarkedString[] = [];
        contents.push({ language: 'typescript', value: ts.displayPartsToString(quickInfo.displayParts) });
        if (quickInfo.documentation && quickInfo.documentation.length > 0) {
          contents.push(ts.displayPartsToString(quickInfo.documentation));
        }
        const range = LSPRange.create(
            textDocument.positionAt(quickInfo.textSpan.start),
            textDocument.positionAt(quickInfo.textSpan.start + quickInfo.textSpan.length)
        );
        return { contents, range };
    }

    return undefined;
} 