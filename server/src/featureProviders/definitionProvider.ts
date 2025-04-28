import * as ts from 'typescript';
import {
    DefinitionParams,
    LocationLink,
    Location,
    Range as LSPRange,
    Position
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import {
    AureliaDocumentInfo,
    DetailedMapping,
    AureliaProjectComponentMap,
    AureliaComponentInfo
} from '../common/types';
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';
import * as parse5 from 'parse5';
import { DefaultTreeAdapterMap } from 'parse5';
import { getTagAtOffset } from '../utils/htmlParsing';
import { getWordRangeAtPosition } from '../utils/utilities';
import * as path from 'path';

/**
 * Finds the precise location of a property definition within a class in a TypeScript source file.
 */
function findPropertyDefinitionRange(propertyName: string, classNode: ts.ClassDeclaration, sourceFile: ts.SourceFile): LSPRange | undefined {
    for (const member of classNode.members) {
        if ((ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name) {
            if (member.name.getText(sourceFile) === propertyName) {
                // Return the range of the property name identifier
                const start = sourceFile.getLineAndCharacterOfPosition(member.name.getStart(sourceFile));
                const end = sourceFile.getLineAndCharacterOfPosition(member.name.getEnd());
                return LSPRange.create(start.line, start.character, end.line, end.character);
            }
        }
    }
    return undefined;
}

/**
 * Handles definition requests for HTML and TS files.
 */
export async function handleDefinitionRequest(
    params: DefinitionParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap,
    program: ts.Program | undefined,
): Promise<LocationLink[] | undefined> {
    const textDocument = documents.get(params.textDocument.uri);
    if (!textDocument) return undefined;

    const uri = params.textDocument.uri;
    const offset = textDocument.offsetAt(params.position);
    program ??= languageService.getProgram();

    if (!program) {
        log('warn', '[onDefinition] Could not get TS Program object.');
        return undefined;
    }

    // --- HTML File Logic ---
    if (uri.endsWith('.html')) {
        const docInfo = aureliaDocuments.get(uri);
        if (!docInfo) {
            log('warn', `[onDefinition] No AureliaDocumentInfo for ${uri}. Definition may require document scan.`);
            return undefined;
        }

        let activeMapping: DetailedMapping | undefined;
        for (const mapping of docInfo.mappings) {
            const checkStart = mapping.type === 'interpolation' ? mapping.htmlExpressionLocation.startOffset - 2 : mapping.htmlExpressionLocation.startOffset;
            const checkEnd = mapping.type === 'interpolation' ? mapping.htmlExpressionLocation.endOffset + 1 : mapping.htmlExpressionLocation.endOffset;
            if (checkStart <= offset && offset <= checkEnd) {
                activeMapping = mapping;
                break;
            }
        }

        // --- Case 1: Inside an expression ---
        if (activeMapping) {
            log('debug', `[onDefinition] Found active mapping for offset ${offset}. Type: ${activeMapping.type}, HTML Range: [${activeMapping.htmlExpressionLocation.startOffset}-${activeMapping.htmlExpressionLocation.endOffset}]`);
            
            // Map HTML offset within expression to virtual file offset
            const virtualDefinitionOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
            log('debug', `[onDefinition] Mapped HTML Offset: ${offset} to Virtual Offset: ${virtualDefinitionOffset} in ${docInfo.virtualUri}`);

            const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
            let definitionInfo: ts.DefinitionInfoAndBoundSpan | undefined;
            try {
                log('debug', `[onDefinition] Calling TS LS getDefinitionAndBoundSpan(${virtualFsPath}, ${virtualDefinitionOffset})`);
                definitionInfo = languageService.getDefinitionAndBoundSpan(virtualFsPath, virtualDefinitionOffset);
            } catch (e) {
                log('error', `[onDefinition] Error getting definition from LS: ${e}`);
                return undefined;
            }

            if (!definitionInfo || !definitionInfo.definitions || definitionInfo.definitions.length === 0) {
                log('debug', '[onDefinition] TS returned no definitions for expression.');
                return undefined;
            }

            const locationLinks: LocationLink[] = [];

            // --- Calculate Origin Span (HTML Highlighting using Transformations) ---
            let originSelectionRangeFromExpression: LSPRange | undefined;
            try {
                const originVirtualSpan = definitionInfo.textSpan;
                const virtualSpanStart = originVirtualSpan.start;
                const virtualSpanEnd = virtualSpanStart + originVirtualSpan.length;

                // Check if the span is within a transformed identifier
                const containingTransformation = activeMapping.transformations.find(t =>
                    virtualSpanStart >= t.virtualRange.start && virtualSpanStart < t.virtualRange.end
                );

                if (containingTransformation) {
                    originSelectionRangeFromExpression = LSPRange.create(
                        textDocument.positionAt(containingTransformation.htmlRange.start),
                        textDocument.positionAt(containingTransformation.htmlRange.end)
                    );
                    log('debug', `[onDefinition] Mapped expression origin via transformation to HTML range ${JSON.stringify(originSelectionRangeFromExpression)}.`);
                } else {
                    // Re-calculate based on accumulated offset deltas
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

                    originSelectionRangeFromExpression = LSPRange.create(
                        textDocument.positionAt(clampedHtmlStart),
                        textDocument.positionAt(clampedHtmlEnd)
                    );

                    log('debug', `[onDefinition] Mapped non-contained expression span to HTML range ${JSON.stringify(originSelectionRangeFromExpression)}.`);
                }
            } catch (e) {
                log('error', `[onDefinition] Error mapping origin span for expression: ${e}`);
            }

            if (!originSelectionRangeFromExpression) {
                // Fallback to the whole expression if precise mapping failed
                originSelectionRangeFromExpression = LSPRange.create(
                    textDocument.positionAt(activeMapping.htmlExpressionLocation.startOffset),
                    textDocument.positionAt(activeMapping.htmlExpressionLocation.endOffset)
                );
            }

            // Iterate over definitions returned by the TS LS
            for (const def of definitionInfo.definitions) {
                const normalizedDefPath = path.normalize(def.fileName);
                const normalizedVirtualFsPath = path.normalize(virtualFsPath);

                // Skip the virtual file itself
                if (normalizedDefPath === normalizedVirtualFsPath) {
                    log('debug', `[onDefinition] Skipping definition that points back to the virtual file: ${def.fileName}`);
                    continue;
                }

                // Skip standard library definitions when navigating from interpolation expressions
                if (
                    activeMapping.type === 'interpolation' &&
                    (normalizedDefPath.includes(`${path.sep}typescript${path.sep}lib${path.sep}lib.`) ||
                        normalizedDefPath.includes(`${path.sep}@types${path.sep}node${path.sep}`))
                ) {
                    log('debug', `[onDefinition] Skipping standard library definition: ${def.fileName}`);
                    continue;
                }

                const targetUri = URI.file(def.fileName).toString();
                const targetSourceFile = program.getSourceFile(def.fileName);
                if (!targetSourceFile) {
                    log('warn', `[onDefinition] Could not get source file for expression definition target: ${def.fileName}`);
                    continue;
                }

                const targetStartPos = ts.getLineAndCharacterOfPosition(targetSourceFile, def.textSpan.start);
                const targetEndPos = ts.getLineAndCharacterOfPosition(
                    targetSourceFile,
                    def.textSpan.start + def.textSpan.length
                );
                const targetRange = LSPRange.create(
                    targetStartPos.line,
                    targetStartPos.character,
                    targetEndPos.line,
                    targetEndPos.character
                );
                const targetSelectionRange = LSPRange.create(
                    targetStartPos.line,
                    targetStartPos.character,
                    targetStartPos.line,
                    targetStartPos.character
                );

                locationLinks.push({
                    targetUri,
                    targetRange,
                    targetSelectionRange,
                    originSelectionRange: originSelectionRangeFromExpression
                });
            }

            if (locationLinks.length > 0) {
                log('info', `[onDefinition] Returning ${locationLinks.length} mapped LocationLinks from expression.`);
                return locationLinks;
            }

            log('debug', '[onDefinition] No valid LocationLinks generated from expression definition.');
            return undefined;
        }
        // --- Case 2: Outside an expression (Tag or Attribute) ---
        else {
            log('debug', `[onDefinition] HTML offset ${offset} is outside expression. Analyzing tags/attributes...`);
            let targetTagName: string | undefined;
            let targetAttributeName: string | undefined;
            let targetNode: parse5.DefaultTreeAdapterMap['element'] | undefined;

            try {
                const documentText = textDocument.getText();
                const fragment = parse5.parseFragment(documentText, { sourceCodeLocationInfo: true });
                let found = false;

                // Recursive function to find the element/attribute at the offset
                const findNodeAtOffset = (nodes: DefaultTreeAdapterMap['node'][] | undefined): boolean => {
                    if (!nodes) return false;
                    for (const node of nodes) {
                        const nodeLoc = node.sourceCodeLocation;
                        if (!nodeLoc) continue;
                        const start = nodeLoc.startOffset;
                        const end = nodeLoc.endOffset;

                        if (offset >= start && offset <= end) {
                             // Check children first (more specific match)
                            if ('childNodes' in node) {
                                if (findNodeAtOffset((node as DefaultTreeAdapterMap['element']).childNodes)) {
                                    return true; // Found in deeper child
                                }
                            }

                            // If not found deeper, check this node
                            // Type guard for element nodes
                            if (node.nodeName !== '#text' && node.nodeName !== '#comment' && 'tagName' in node) {
                                const elementNode = node as parse5.DefaultTreeAdapterMap['element'];
                                const elementLoc = nodeLoc as parse5.Token.ElementLocation; // Assume ElementLocation if tagName exists

                                // Check if cursor is on the tag name
                                if (elementLoc.startTag && offset >= (elementLoc.startTag.startOffset + 1) && offset <= (elementLoc.startTag.startOffset + 1 + elementNode.tagName.length)) {
                                    targetNode = elementNode;
                                    targetTagName = elementNode.tagName;
                                    return true; // Found: on tag name
                                }

                                // Check if cursor is on an attribute name
                                if (elementLoc.attrs) {
                                     for (const attr of elementNode.attrs) {
                                        const attrLoc = elementLoc.attrs[attr.name];
                                        if (attrLoc && offset >= attrLoc.startOffset && offset <= attrLoc.endOffset) {
                                            const nameEndOffset = attrLoc.startOffset + attr.name.length;
                                            if (offset <= nameEndOffset) {
                                                targetNode = elementNode; // Store the parent element
                                                targetAttributeName = attr.name;
                                                return true; // Found: on attribute name
                                            }
                                        }
                                    }
                                }
                            }
                            // If offset is within this node but not on tag/attribute name,
                            // and not found in children, stop searching this branch
                             return false;
                        }
                    }
                    return false; // Not found in this list of nodes
                };

                found = findNodeAtOffset(fragment.childNodes);

                 // --- Handle found tag or attribute --- 
                let finalTargetUri: string | undefined;
                let finalTargetRange = LSPRange.create(0, 0, 0, 0); // Default range
                let finalSelectionRange = finalTargetRange;
                let originSelectionRange: LSPRange | undefined = undefined; // Range in the HTML doc

                if (targetTagName && targetNode && !targetAttributeName) {
                    log('debug', `[onDefinition] Found target element: ${targetTagName}`);
                    const componentInfo = aureliaProjectComponents.get(targetTagName);
                    
                    if (componentInfo?.uri && componentInfo.sourceFile) { 
                        finalTargetUri = componentInfo.uri;

                        if (componentInfo.type === 'element' && !componentInfo.className) {
                             log('debug', `[onDefinition] Target is HTML-only component. Pointing to HTML file.`);
                             finalTargetRange = LSPRange.create(0, 0, 0, 0); // Go to start of HTML file
                             finalSelectionRange = finalTargetRange;
                        }
                        else if (componentInfo.className) {
                            log('debug', `[onDefinition] Target is TS-based component. Finding class definition.`);
                            const sourceFile = program.getSourceFile(componentInfo.sourceFile);
                            if (sourceFile) {
                                // Find class declaration range
                                ts.forEachChild(sourceFile, node => {
                                    if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === componentInfo.className) {
                                        if (node.name) {
                                            const start = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
                                            const end = sourceFile.getLineAndCharacterOfPosition(node.name.getEnd());
                                            // Use class name for both target and selection range
                                            finalTargetRange = LSPRange.create(start.line, start.character, end.line, end.character);
                                            finalSelectionRange = finalTargetRange;
                                        }
                                        return true; // Stop searching
                                    }
                                });
                            }
                        }
                         // Set origin range to the tag name in HTML
                         const elementLoc = targetNode.sourceCodeLocation as parse5.Token.ElementLocation;
                         if (elementLoc?.startTag) {
                            const tagStartOffset = elementLoc.startTag.startOffset + 1;
                            originSelectionRange = LSPRange.create(
                                textDocument.positionAt(tagStartOffset),
                                textDocument.positionAt(tagStartOffset + targetTagName.length)
                            );
                         }
                    } else {
                        log('debug', `[onDefinition] Target element <${targetTagName}> is not a known custom element or missing info.`);
                    }

                } else if (targetAttributeName && targetNode) {
                     // Go to definition for a Custom Attribute or a Bindable Property
                    log('debug', `[onDefinition] Found target attribute: ${targetAttributeName} on element <${targetNode.tagName}>`);
                    const baseAttributeName = targetAttributeName.split('.')[0]; // a.bind -> a
                    let targetPropertyName: string | undefined;

                     // Set origin range to the base attribute name in HTML
                     const elementLoc = targetNode.sourceCodeLocation as parse5.Token.ElementLocation;
                     const attrLoc = elementLoc?.attrs?.[targetAttributeName];
                     if (attrLoc) {
                         originSelectionRange = LSPRange.create(
                             textDocument.positionAt(attrLoc.startOffset),
                             textDocument.positionAt(attrLoc.startOffset + baseAttributeName.length) // Select only base name
                         );
                     }

                    // Priority 1: Is it a known Custom Attribute?
                    let componentInfo = aureliaProjectComponents.get(baseAttributeName);
                    // Ensure componentInfo exists and has necessary properties
                    if (componentInfo?.type === 'attribute' && componentInfo.uri && componentInfo.sourceFile && componentInfo.className) {
                        log('debug', `[onDefinition] Attribute '${baseAttributeName}' is a Custom Attribute.`);
                        finalTargetUri = componentInfo.uri;
                        const sourceFile = program.getSourceFile(componentInfo.sourceFile);
                        if (sourceFile) {
                             // Find class declaration range
                            ts.forEachChild(sourceFile, node => {
                                if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === componentInfo!.className) { // componentInfo is checked
                                    if (node.name) {
                                        const start = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
                                        const end = sourceFile.getLineAndCharacterOfPosition(node.name.getEnd());
                                        finalTargetRange = LSPRange.create(start.line, start.character, end.line, end.character);
                                        finalSelectionRange = finalTargetRange;
                                    }
                                    return true;
                                }
                            });
                        }
                    } else {
                        // Priority 2: Is it a bindable property of the containing element?
                        componentInfo = aureliaProjectComponents.get(targetNode.tagName); // Get info for the *element*
                        // Ensure componentInfo exists and has necessary properties
                        if (componentInfo?.type === 'element' && componentInfo.bindables && componentInfo.uri && componentInfo.sourceFile && componentInfo.className) {
                            const bindableInfo = componentInfo.bindables.find(b =>
                                b.propertyName === baseAttributeName || b.attributeName === baseAttributeName
                            );
                            if (bindableInfo) {
                                log('debug', `[onDefinition] Attribute '${baseAttributeName}' is a bindable property '${bindableInfo.propertyName}' on <${targetNode.tagName}>.`);
                                finalTargetUri = componentInfo.uri; // Definition is in the element's VM
                                targetPropertyName = bindableInfo.propertyName;
                                const sourceFile = program.getSourceFile(componentInfo.sourceFile);
                                if (sourceFile) {
                                     // Find property definition range
                                    ts.forEachChild(sourceFile, node => {
                                        if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === componentInfo!.className) { // componentInfo is checked
                                            const range = findPropertyDefinitionRange(targetPropertyName!, node, sourceFile); // targetPropertyName is set
                                            if (range) {
                                                finalTargetRange = range;
                                                finalSelectionRange = range;
                                                return true; // Stop searching
                                            }
                                        }
                                    });
                                }
                            }
                        }
                    }

                    if (!finalTargetUri) {
                         log('debug', `[onDefinition] Could not find definition for attribute '${baseAttributeName}' on element <${targetNode.tagName}>.`);
                    }

                } else {
                    log('debug', `[onDefinition] No specific tag or attribute name identified at offset ${offset}.`);
                }

                // Return result if a definition was found
                if (finalTargetUri) {
                    return [{
                        targetUri: finalTargetUri,
                        targetRange: finalTargetRange,
                        targetSelectionRange: finalSelectionRange,
                        originSelectionRange: originSelectionRange
                    }];
                }

            } catch (error) {
                log('error', `[onDefinition] Error parsing HTML for tag/attribute definition: ${error}`);
            }
            return undefined; // Fallthrough if no definition found
        }
    } 
    // --- TS File Logic ---
    else if (uri.endsWith('.ts')) {
        log('debug', `[onDefinition] Request inside TS file: ${uri}`);
        let definitionInfo: readonly ts.DefinitionInfo[] | undefined;
        try {
            definitionInfo = languageService.getDefinitionAtPosition(URI.parse(uri).fsPath, offset);
        } catch (e) { 
            log('error', `[onDefinition] Error getting definition from LS for TS file: ${e}`);
            return undefined;
        }
        
        if (!definitionInfo || definitionInfo.length === 0) return undefined;

        const locationLinks: LocationLink[] = definitionInfo.map(definition => {
            const targetUri = URI.file(definition.fileName).toString();
            const targetDoc = documents.get(targetUri) ?? TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(definition.fileName) ?? '');
            let targetRange = LSPRange.create(0,0,0,0);
            let targetSelectionRange = targetRange;

            if (targetDoc) {
                targetRange = LSPRange.create(
                    targetDoc.positionAt(definition.textSpan.start),
                    targetDoc.positionAt(definition.textSpan.start + definition.textSpan.length)
                );
                targetSelectionRange = targetRange; // Default selection to full span

                // Use contextSpan if available for potentially better range
                 if (definition.contextSpan) {
                     targetRange = LSPRange.create(
                         targetDoc.positionAt(definition.contextSpan.start),
                         targetDoc.positionAt(definition.contextSpan.start + definition.contextSpan.length)
                     );
                 }
                 // Refine selection range for specific kinds (like class names)
                 if (definition.kind === ts.ScriptElementKind.classElement) {
                     const sourceFile = program!.getSourceFile(definition.fileName);
                     if (sourceFile) {
                         ts.forEachChild(sourceFile, node => {
                            if (ts.isClassDeclaration(node) && node.name && node.name.getStart(sourceFile) === definition.textSpan.start) {
                                const start = sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile));
                                const end = sourceFile.getLineAndCharacterOfPosition(node.name.getEnd());
                                targetSelectionRange = LSPRange.create(start.line, start.character, end.line, end.character);
                                return true;
                            }
                         });
                     }
                 }
            }

            return {
                targetUri: targetUri,
                targetRange: targetRange,
                targetSelectionRange: targetSelectionRange
                // originSelectionRange: TBD if needed for TS->TS
            };
        });
        return locationLinks;
    }

    return undefined;
}