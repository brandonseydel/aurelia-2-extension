import * as ts from 'typescript';
import {
    ReferenceParams,
    Location as LSPLocation,
    Range as LSPRange
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping, AureliaProjectComponentMap, AureliaComponentInfo } from '../common/types';
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';
import * as parse5 from 'parse5';
import { DefaultTreeAdapterMap } from 'parse5';
import * as fs from 'fs';

/**
 * Finds all occurrences of a given HTML tag name or attribute name within the HTML content
 * of all Aurelia documents known to the server.
 *
 * @param name The tag or attribute name to search for.
 * @param type Whether searching for an 'element' or 'attribute'.
 * @param aureliaDocuments Map of Aurelia documents.
 * @param documents TextDocuments manager to get document objects.
 * @returns A promise resolving to an array of LSPLocations.
 */
async function findHtmlReferences(
    name: string,
    type: 'element' | 'attribute',
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    documents: TextDocuments<TextDocument>
): Promise<LSPLocation[]> {
    const locations: LSPLocation[] = [];
    const searchTasks: Promise<void>[] = [];

    for (const [htmlUri, docInfo] of aureliaDocuments.entries()) {
        searchTasks.push((async () => {
            let document = documents.get(htmlUri);
            let htmlContent: string;

            if (document) {
                htmlContent = document.getText();
            } else {
                // If document not open, try reading from disk
                try {
                    const fsPath = URI.parse(htmlUri).fsPath;
                    htmlContent = await fs.promises.readFile(fsPath, 'utf-8');
                    // Create a temporary document for offset calculations
                    document = TextDocument.create(htmlUri, 'html', 0, htmlContent);
                } catch (e) {
                    log('warn', `[findHtmlReferences] Error reading non-open file ${htmlUri}: ${e}`);
                    return; // Skip this file if reading fails
                }
            }
            if (!document) return; // Should not happen if reading worked

            try {
                const fragment = parse5.parseFragment(htmlContent, { sourceCodeLocationInfo: true });
                const findNodes = (nodes: DefaultTreeAdapterMap['node'][] | undefined) => {
                    if (!nodes) return;
                    for (const node of nodes) {
                        const nodeLoc = node.sourceCodeLocation as parse5.Token.ElementLocation; // Cast to ElementLocation
                        if (nodeLoc) {
                            if (type === 'element' && node.nodeName === name && nodeLoc.startTag) {
                                const startOffset = nodeLoc.startTag.startOffset + 1;
                                const endOffset = startOffset + name.length;
                                if (document) {
                                    locations.push({
                                        uri: htmlUri,
                                        range: LSPRange.create(document.positionAt(startOffset), document.positionAt(endOffset))
                                    });
                                }
                            }
                            // Check Attributes (Duck type + 'any' cast)
                            else if (type === 'attribute' && 'attrs' in node && node.attrs && nodeLoc.attrs) {
                                const elementLoc: any = nodeLoc; // <<< Cast to any
                                for (const attr of node.attrs) {
                                    if (attr.name === name || (attr.name.startsWith(name + '.') && !attr.name.endsWith('.ref'))) {
                                        const attrLocation = elementLoc.attrs[attr.name];
                                        if (attrLocation && document) {
                                            locations.push({
                                                uri: htmlUri,
                                                range: LSPRange.create(document.positionAt(attrLocation.startOffset), document.positionAt(attrLocation.startOffset + name.length))
                                            });
                                        }
                                    }
                                }
                            }
                            // Recurse
                            if ('childNodes' in node) {
                                findNodes((node as DefaultTreeAdapterMap['element']).childNodes);
                            }
                        }
                    }
                };
                findNodes(fragment.childNodes);
            } catch (error) {
                log('error', `[findHtmlReferences] Error parsing HTML fragment for ${htmlUri}: ${error}`);
            }
        })());
    }

    await Promise.all(searchTasks);
    log('debug', `[findHtmlReferences] Found ${locations.length} HTML references for ${name} (${type}).`);
    return locations;
}

/**
 * Handles find references requests for both HTML and TS files.
 */
export async function handleReferencesRequest(
    params: ReferenceParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap
): Promise<LSPLocation[] | undefined> {
    const fileUri = params.textDocument.uri;
    const document = documents.get(fileUri);
    if (!document) return undefined;

    const locations: LSPLocation[] = [];
    const fileFsPath = URI.parse(fileUri).fsPath;
    const offset = document.offsetAt(params.position);

    // --- Branch 1: TypeScript File --- 
    if (fileUri.endsWith('.ts')) {
        log('debug', `[onReferences] Request initiated from TS file: ${fileUri}`);
        let tsReferences: ts.ReferencedSymbol[] | undefined;
        try {
            tsReferences = languageService.findReferences(fileFsPath, offset);
        } catch (e) {
            log('error', `[onReferences] Error calling LS findReferences for TS file: ${e}`);
            return undefined;
        }
        if (!tsReferences) return undefined;

        log('info', `[onReferences] TS LS found ${tsReferences.length} symbols for TS file.`);
        // Convert TS references to LSP Locations
        for (const symbol of tsReferences) {
            for (const reference of symbol.references) {
                const targetFsPath = reference.fileName;
                const targetUri = URI.file(targetFsPath).toString();
                const targetDoc = documents.get(targetUri) ?? TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPath) ?? '');
                if (targetDoc) {
                    const range = LSPRange.create(
                        targetDoc.positionAt(reference.textSpan.start),
                        targetDoc.positionAt(reference.textSpan.start + reference.textSpan.length)
                    );
                    locations.push(LSPLocation.create(targetUri, range));
                }
            }
        }

        // TODO: Additional HTML search if the referenced symbol is an Aurelia component/bindable
        // This will involve:
        // 1. Getting details about the symbol at the original TS offset (e.g., class name, property name)
        // 2. Checking if it matches a component in aureliaProjectComponents
        // 3. If it matches, determining the corresponding HTML tag/attribute name
        // 4. Searching all HTML documents in aureliaDocuments for that name

        // --- Branch 2: HTML File --- 
    } else if (fileUri.endsWith('.html')) {
        log('debug', `[onReferences] Request initiated from HTML file: ${fileUri}`);
        const docInfo = aureliaDocuments.get(fileUri);
        if (!docInfo) {
            log('warn', `[onReferences] No AureliaDocumentInfo found for HTML file: ${fileUri}`);
            return undefined;
        }

        let activeMapping: DetailedMapping | undefined;
        for (const mapping of docInfo.mappings) {
            // TODO: Adjust range check? Interpolation might need offset +- 2 like in completion
            if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
                activeMapping = mapping;
                break;
            }
        }

        if (activeMapping) {
            // --- Sub-branch 2.1: Inside an Expression --- 
            log('debug', `[onReferences] Offset ${offset} is within mapped expression.`);
            const virtualOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
            log('debug', `[onReferences] Mapped HTML Offset ${offset} to Virtual Offset ${virtualOffset}`);

            const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
            let referencedSymbols: ts.ReferencedSymbol[] | undefined;
            try {
                referencedSymbols = languageService.findReferences(virtualFsPath, virtualOffset);
            } catch (e) {
                log('error', `[onReferences] Error calling LS for virtual file: ${e}`);
                return undefined;
            }

            if (!referencedSymbols) {
                log('debug', "[onReferences] TS could not find reference symbols in virtual file.");
                return undefined;
            }

            log('info', `[onReferences] Found ${referencedSymbols.length} referenced symbols via virtual file.`);

            for (const symbol of referencedSymbols) {
                log('debug', `  - Symbol has ${symbol.references.length} references.`);
                for (const reference of symbol.references) {
                    const targetFsPath = reference.fileName;
                    const targetUri = URI.file(targetFsPath).toString();
                    const locationVirtualSpan = reference.textSpan;
                    const virtualStart = locationVirtualSpan.start;
                    const virtualEnd = virtualStart + locationVirtualSpan.length;
                    let targetRange: LSPRange | undefined;

                    if (targetFsPath === docInfo.vmFsPath) {
                        // Case 1: Location is in the original ViewModel file
                        const vmDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPath) ?? '');
                        if (vmDocument) {
                            targetRange = LSPRange.create(
                                vmDocument.positionAt(virtualStart),
                                vmDocument.positionAt(virtualEnd)
                            );
                        }
                    } else if (targetFsPath === URI.parse(docInfo.virtualUri).fsPath) {
                        // Case 2: Location is in the Virtual File (map back to HTML)
                        let locationMapping = docInfo.mappings.find(m =>
                            m.virtualValueRange.start <= virtualStart && virtualEnd <= m.virtualValueRange.end
                        );
                        if (!locationMapping) {
                            // Attempt fallback: Find mapping where the reference *starts* within the value range
                            locationMapping = docInfo.mappings.find(m =>
                                m.virtualValueRange.start <= virtualStart && virtualStart < m.virtualValueRange.end
                            );
                            if (!locationMapping) {
                                log('warn', `[onReferences] Could not find mapping for virtual reference location [${virtualStart}-${virtualEnd}]`);
                                continue;
                            }
                        }

                        // Map Virtual Span back to HTML Range (using transformation logic)
                        // This logic seems complex, needs careful review/testing
                        let htmlStartOffset: number;
                        let htmlEndOffset: number;

                        const containingTransformation = locationMapping.transformations.find(t =>
                            virtualStart >= t.virtualRange.start && virtualStart < t.virtualRange.end
                        );

                        if (containingTransformation) {
                            htmlStartOffset = containingTransformation.htmlRange.start;
                            htmlEndOffset = containingTransformation.htmlRange.end;
                        } else {
                            let accumulatedOffsetDeltaBeforeStart = 0;
                            for (const transform of locationMapping.transformations) {
                                if (transform.virtualRange.end <= virtualStart) {
                                    accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                                }
                            }
                            const baseHtmlOffset = locationMapping.htmlExpressionLocation.startOffset;
                            const baseVirtualOffset = locationMapping.virtualValueRange.start;
                            htmlStartOffset = baseHtmlOffset + (virtualStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
                            const spanLength = virtualEnd - virtualStart;
                            htmlEndOffset = htmlStartOffset + spanLength; // Assume length is same if no transformation applied directly

                            // Check if end offset falls within a transformation start
                            let deltaAtEnd = 0;
                            for (const transform of locationMapping.transformations) {
                                if (transform.virtualRange.start >= virtualStart && transform.virtualRange.start < virtualEnd) {
                                    deltaAtEnd += transform.offsetDelta;
                                }
                            }
                            htmlEndOffset -= deltaAtEnd;

                        }

                        // Clamp and validate
                        const htmlExprStart = locationMapping.htmlExpressionLocation.startOffset;
                        const htmlExprEnd = locationMapping.htmlExpressionLocation.endOffset;
                        const clampedHtmlStart = Math.max(htmlStartOffset, htmlExprStart);
                        let clampedHtmlEnd = Math.min(htmlEndOffset, htmlExprEnd);
                        clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd); // Ensure end is not before start

                        if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart && clampedHtmlEnd >= clampedHtmlStart) {
                            targetRange = LSPRange.create(
                                document.positionAt(clampedHtmlStart),
                                document.positionAt(clampedHtmlEnd)
                            );
                        } else {
                            log('warn', `[onReferences] Invalid mapped HTML range [${clampedHtmlStart}-${clampedHtmlEnd}] for virtual ref [${virtualStart}-${virtualEnd}] mapped from [${htmlStartOffset}-${htmlEndOffset}]`);
                            continue;
                        }
                    } else {
                        // Case 3: Location is in some other TS file
                        const otherDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPath) ?? '');
                        if (otherDocument) {
                            targetRange = LSPRange.create(
                                otherDocument.positionAt(virtualStart),
                                otherDocument.positionAt(virtualEnd)
                            );
                        }
                    }

                    if (targetRange) {
                        // Avoid adding duplicate locations
                        if (!locations.some(loc => loc.uri === targetUri &&
                            loc.range.start.line === targetRange.start.line &&
                            loc.range.start.character === targetRange.start.character &&
                            loc.range.end.line === targetRange.end.line &&
                            loc.range.end.character === targetRange.end.character)) {
                            locations.push(LSPLocation.create(targetUri, targetRange));
                        }
                    }
                }
            }
        } else {
            // --- Sub-branch 2.2: On HTML Tag or Attribute (Not in expression) --- 
            log('debug', `[onReferences] Offset ${offset} is outside any mapped expression. Analyzing HTML structure...`);
            let definitionLocation: LSPLocation | undefined;
            let htmlRefs: LSPLocation[] = [];
            let targetName: string | undefined;
            let targetType: 'element' | 'attribute' | undefined;

            try {
                // Use parse5 to find the node/attribute at the offset
                const documentText = document.getText();
                const fragment = parse5.parseFragment(documentText, { sourceCodeLocationInfo: true });
                let found = false;

                const findNodeAtOffset = (nodes: DefaultTreeAdapterMap['node'][] | undefined): boolean => {
                    if (!nodes) return false;
                    for (const node of nodes) {
                        const nodeLoc = node.sourceCodeLocation as parse5.Token.ElementLocation; // Cast to ElementLocation
                        if (nodeLoc) {
                            const start = nodeLoc.startOffset;
                            const end = nodeLoc.endOffset;

                            // Check if offset is within the node's range *before* checking children
                            if (offset >= start && offset <= end) {
                                let nodeContainsTarget = false;
                                // Check children first (more specific match)
                                if ('childNodes' in node) {
                                    nodeContainsTarget = findNodeAtOffset((node as DefaultTreeAdapterMap['element']).childNodes);
                                }

                                // If not found in children, check the current node (tag/attributes)
                                if (!nodeContainsTarget) {
                                    // Check Tag Name (Duck type + 'any' cast)
                                    if ('tagName' in node && nodeLoc.startTag) {
                                        const elementLoc: any = nodeLoc; // <<< Cast to any
                                        const tagName = node.tagName;
                                        const tagStart = elementLoc.startTag.startOffset + 1;
                                        const tagEnd = tagStart + tagName.length;
                                        if (offset >= tagStart && offset <= tagEnd) {
                                            targetName = tagName;
                                            targetType = 'element';
                                            return true; // Found target
                                        }
                                    }
                                    // Check Attributes (Duck type + 'any' cast)
                                    if ('attrs' in node && node.attrs && nodeLoc.attrs) {
                                        const elementLoc: any = nodeLoc; // <<< Cast to any
                                        for (const attr of node.attrs) {
                                            const attrLoc = elementLoc.attrs[attr.name];
                                            if (attrLoc && offset >= attrLoc.startOffset && offset <= attrLoc.endOffset) {
                                                const nameEndOffset = attrLoc.startOffset + attr.name.length;
                                                if (offset <= nameEndOffset) {
                                                    targetName = attr.name;
                                                    const dotIndex = targetName.indexOf('.');
                                                    if (dotIndex > 0 && !targetName.endsWith('.ref')) {
                                                        targetName = targetName.substring(0, dotIndex);
                                                    }
                                                    targetType = 'attribute';
                                                    return true; // Found target
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    return true; // Found in children, stop searching this branch
                                }
                            } // end if offset in node range
                        } // end if nodeLoc
                    } // end for loop
                    return false; // Not found in this list of nodes
                };

                found = findNodeAtOffset(fragment.childNodes);

                if (targetName && targetType) {
                    log('info', `[onReferences] Identified target '${targetName}' (${targetType}) at offset ${offset}`);
                    const componentInfo = aureliaProjectComponents.get(targetName);

                    if (componentInfo) {
                        // 1. Add Definition Location
                        const defUri = componentInfo.uri;
                        const defDoc = TextDocument.create(defUri, 'typescript', 0, ts.sys.readFile(URI.parse(defUri).fsPath) ?? '');
                        // TODO: Find exact class/property definition range in TS? For now, use start of file.
                        definitionLocation = LSPLocation.create(defUri, LSPRange.create(0, 0, 0, 0));
                        locations.push(definitionLocation);

                        // 2. Find HTML References
                        htmlRefs = await findHtmlReferences(targetName, targetType, aureliaDocuments, documents);
                        locations.push(...htmlRefs);

                    } else {
                        log('warn', `[onReferences] Could not find component definition for '${targetName}' in project map.`);
                        // Potentially handle standard HTML elements/attributes or bindables here?
                        // If it's an attribute, need to check if it's a bindable of the *containing* element tag.
                        // This requires finding the parent element tag first.
                    }
                } else {
                    log('debug', `[onReferences] Could not determine HTML tag/attribute at offset ${offset}.`);
                }
            } catch (error) {
                log('error', `[onReferences] Error parsing HTML for tag/attribute analysis: ${error}`);
            }
        }
    } else {
        log('warn', `[onReferences] Unsupported file type: ${fileUri}`);
        return undefined;
    }

    log('info', `[onReferences] Returning ${locations.length} final locations.`);
    // Remove duplicates before returning
    const uniqueLocations = locations.filter((loc, index, self) =>
        index === self.findIndex((l) => (
            l.uri === loc.uri &&
            l.range.start.line === loc.range.start.line &&
            l.range.start.character === loc.range.start.character &&
            l.range.end.line === loc.range.end.line &&
            l.range.end.character === loc.range.end.character
        ))
    );
    return uniqueLocations;
} 