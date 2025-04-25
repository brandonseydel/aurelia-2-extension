import * as ts from 'typescript';
import {
    PrepareRenameParams,
    RenameParams,
    WorkspaceEdit,
    TextEdit,
    TextDocumentEdit,
    Range as LSPRange
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping, AureliaProjectComponentMap } from '../common/types'; 
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';
import { getTagAtOffset } from '../utils/htmlParsing';
import { getWordRangeAtPosition } from '../utils/utilities';

// +++ Define Cache Type +++
type ViewModelMembersCache = Map<string, { content: string | undefined; members: string[] }>;

/**
 * Handles prepare rename requests.
 */
export async function handlePrepareRenameRequest(
    params: PrepareRenameParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap
): Promise<LSPRange | { range: LSPRange, placeholder: string } | null> {
    const triggerUri = params.textDocument.uri;
    const document = documents.get(triggerUri);
    if (!document) return null; 

    const offset = document.offsetAt(params.position);

    if (triggerUri.endsWith('.html')) {
        const text = document.getText();
        const tagInfo = await getTagAtOffset(text, offset);

        if (tagInfo) {
            log('debug', `[onPrepareRename] Found tag '${tagInfo.tagName}' at offset ${offset}. Type: ${tagInfo.type}`);
            const componentInfo = aureliaProjectComponents.get(tagInfo.tagName);

            if (componentInfo && (componentInfo.type === 'element' || componentInfo.type === 'attribute')) {
                 log('debug', `[onPrepareRename] Tag '${tagInfo.tagName}' is a known Aurelia ${componentInfo.type}. Allowing rename.`);
                
                 let renameRange: LSPRange | undefined;
                 if (tagInfo.locations) {
                     const relevantLocation = tagInfo.type === 'start' ? tagInfo.locations.startTag : tagInfo.locations.endTag;
                     if (relevantLocation) {
                         const startOffsetCorrection = tagInfo.type === 'start' ? 1 : 2;
                         const startPos = document.positionAt(relevantLocation.startOffset + startOffsetCorrection);
                         const endPos = document.positionAt(relevantLocation.startOffset + startOffsetCorrection + tagInfo.tagName.length);
                         renameRange = LSPRange.create(startPos, endPos);
                     }
                 }

                 if (!renameRange) {
                      log('warn', `[onPrepareRename] Could not get precise location for tag '${tagInfo.tagName}' from parser. Using word range fallback.`);
                     const wordRange = getWordRangeAtPosition(document, params.position);
                     if (wordRange && document.getText(wordRange) === tagInfo.tagName) {
                        renameRange = wordRange;
                     } else {
                         log('warn', `[onPrepareRename] Fallback word range check failed for tag '${tagInfo.tagName}'. Denying rename.`);
                         return null;
                     }
                 }

                 log('info', `[onPrepareRename] Allowing rename for tag '${tagInfo.tagName}' at range: ${JSON.stringify(renameRange)}`);
                 return renameRange; 
            } else {
                log('debug', `[onPrepareRename] Tag '${tagInfo.tagName}' found, but it's not a known Aurelia component. Passing through.`);
            }
        }
    } else if (triggerUri.endsWith('.ts')) {
        log('debug', `[onPrepareRename] TS file detected, decorator rename check not yet implemented.`);
    }

    if (triggerUri.endsWith('.html')) {
        const docInfo = aureliaDocuments.get(triggerUri);
        if (!docInfo) return null; 

        let activeMapping: DetailedMapping | undefined;
        for (const mapping of docInfo.mappings) {
            if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
                activeMapping = mapping;
                break;
            }
        }

        if (!activeMapping) {
            log('debug', `[onPrepareRename] HTML offset ${offset} not on tag (checked above) and not in expression.`);
            return null; 
        }
        
        const virtualOffset = mapHtmlOffsetToVirtual(offset, activeMapping); 
        log('debug', `[onPrepareRename] Mapped HTML Offset ${offset} to Virtual Offset ${virtualOffset} for expression rename.`);
    
        const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
        const virtualFile = languageService.getProgram()?.getSourceFile(virtualFsPath);
        if (!virtualFile) {
             log('warn', `[onPrepareRename] Could not get virtual source file ${virtualFsPath} from program.`);
             return null;
        }

        const definitionInfo = languageService.getDefinitionAndBoundSpan(virtualFsPath, virtualOffset);
        if (!definitionInfo || !definitionInfo.definitions || definitionInfo.definitions.length === 0) {
            log('debug', "[onPrepareRename] No definition found at virtual offset, cannot rename expression symbol.");
            return null;
        }
        const originVirtualSpan = definitionInfo.textSpan;
    
        const renameInfo = languageService.getRenameInfo(virtualFsPath, originVirtualSpan.start, { allowRenameOfImportPath: false });
        if (!renameInfo.canRename) {
            log('debug', "[onPrepareRename] TS reports rename not possible for the identified expression span.");
            return null;
        }
    
        const virtualSpanStart = originVirtualSpan.start;
        const virtualSpanEnd = virtualSpanStart + originVirtualSpan.length;
        let htmlStartOffset: number | undefined;
        let htmlEndOffset: number | undefined;
    
        const containingTransformation = activeMapping.transformations.find(t => 
            virtualSpanStart >= t.virtualRange.start && virtualSpanStart < t.virtualRange.end
        );
    
        if (containingTransformation) {
            htmlStartOffset = containingTransformation.htmlRange.start;
            const htmlLength = containingTransformation.htmlRange.end - containingTransformation.htmlRange.start;
            htmlEndOffset = containingTransformation.htmlRange.start + htmlLength; 
            log('debug', `[onPrepareRename][Expr] Using containing transformation range: ${htmlStartOffset}-${htmlEndOffset}`);
        } else {
            log('debug', `[onPrepareRename][Expr] Virtual span ${virtualSpanStart}-${virtualSpanEnd} not in transformation. Mapping manually.`);
            let accumulatedOffsetDeltaBeforeStart = 0;
            for (const transform of activeMapping.transformations) {
                if (transform.virtualRange.end <= virtualSpanStart) {
                    accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                }
            }
            const baseHtmlOffset = activeMapping.htmlExpressionLocation.startOffset;
            const baseVirtualOffset = activeMapping.virtualValueRange.start;
            htmlStartOffset = baseHtmlOffset + (virtualSpanStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
            const spanLength = virtualSpanEnd - virtualSpanStart;
            htmlEndOffset = htmlStartOffset + spanLength;
        }
    
        const htmlExprStart = activeMapping.htmlExpressionLocation.startOffset;
        const htmlExprEnd = activeMapping.htmlExpressionLocation.endOffset;
        const clampedHtmlStart = Math.max(htmlStartOffset ?? htmlExprStart, htmlExprStart); 
        let clampedHtmlEnd = Math.min(htmlEndOffset ?? htmlExprEnd, htmlExprEnd); 
        clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);
    
        if (clampedHtmlStart > htmlExprEnd || clampedHtmlEnd < clampedHtmlStart || htmlStartOffset === undefined || htmlEndOffset === undefined) {
            log('warn', `[onPrepareRename][Expr] Invalid mapped HTML range after clamping [${clampedHtmlStart}-${clampedHtmlEnd}], original: [${htmlStartOffset}-${htmlEndOffset}]`);
            return null;
        }
    
        const htmlRange = LSPRange.create(
            document.positionAt(clampedHtmlStart),
            document.positionAt(clampedHtmlEnd)
        );
        const placeholder = document.getText(htmlRange);
    
        log('info', `[onPrepareRename] Rename possible for range (expression): ${JSON.stringify(htmlRange)}, placeholder: ${placeholder}`);
        return { range: htmlRange, placeholder };
    }

    log('debug', `[onPrepareRename] Offset ${offset} in ${triggerUri} did not correspond to a renameable Aurelia entity (tag, decorator name, or expression symbol).`);
    return null; 
}

/**
 * Handles rename requests.
 */
export async function handleRenameRequest(
    params: RenameParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    viewModelMembersCache: ViewModelMembersCache
): Promise<WorkspaceEdit | undefined> {
    log('info', `[onRenameRequest] Handler Entered. URI: ${params.textDocument.uri}`);
    
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const offset = document.offsetAt(params.position);
    const newName = params.newName;

    let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
            activeMapping = mapping;
            break;
        }
    }

    if (!activeMapping) {
        log('warn', `[onRenameRequest] Offset ${offset} not within mapped expression.`);
        return undefined; 
    }

    const virtualOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
    log('debug', `[onRenameRequest] Mapped HTML Offset ${offset} to Virtual Offset ${virtualOffset}`);

    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    let renameLocations: readonly ts.RenameLocation[] | undefined;
    try {
        renameLocations = languageService.findRenameLocations(virtualFsPath, virtualOffset, false, false);
    } catch (e) {
        log('error', `[onRenameRequest] Error calling LS: ${e}`);
        return undefined;
    }
    
    if (!renameLocations) {
        log('warn', "[onRenameRequest] TS could not find rename locations.");
        return undefined;
    }

    log('info', `[onRenameRequest] Found ${renameLocations.length} potential rename locations.`);

    const editsByUri: Map<string, TextEdit[]> = new Map();
    let vmFileAffected = false; // Flag to check if VM file was part of the rename

    for (const location of renameLocations) {
        const targetFsPathRaw = location.fileName;
        const targetFsPath = targetFsPathRaw.replace(/\\/g, '/'); 
        let targetUri = URI.file(targetFsPathRaw).toString();
        const locationVirtualSpan = location.textSpan;
        const virtualStart = locationVirtualSpan.start;
        const virtualEnd = virtualStart + locationVirtualSpan.length;
        let targetRange: LSPRange | undefined;

        const normalizedVmFsPath = docInfo.vmFsPath.replace(/\\/g, '/');
        const normalizedVirtualFsPath = URI.parse(docInfo.virtualUri).fsPath.replace(/\\/g, '/');

        if (targetFsPath === normalizedVmFsPath) {
            // Case 1: Location is in the original ViewModel file
            vmFileAffected = true; // <<< Set flag
            const vmDocument = TextDocument.create(targetUri, 'typescript', 0, ts.sys.readFile(targetFsPathRaw) ?? '');
            if (vmDocument) {
                targetRange = LSPRange.create(vmDocument.positionAt(virtualStart), vmDocument.positionAt(virtualEnd));
            }
        } else if (targetFsPath === normalizedVirtualFsPath) {
            // Case 2: Location is in the Virtual File (map back to HTML)
            targetUri = htmlUri; // Edit needs to be applied to the original HTML URI
            let locationMapping = docInfo.mappings.find(m => 
                m.virtualValueRange.start <= virtualStart && virtualEnd <= m.virtualValueRange.end
            );
            if (!locationMapping) {
                log('warn', `[onRenameRequest] Could not find mapping for virtual rename location [${virtualStart}-${virtualEnd}]`);
                continue;
            }

            let htmlStartOffset: number;
            let htmlEndOffset: number;
            const containingTransformation = locationMapping.transformations.find(t => 
                virtualStart >= t.virtualRange.start && virtualStart < t.virtualRange.end
             );

             if (containingTransformation) {
                 htmlStartOffset = containingTransformation.htmlRange.start;
                 const htmlLength = containingTransformation.htmlRange.end - containingTransformation.htmlRange.start;
                 htmlEndOffset = containingTransformation.htmlRange.start + htmlLength;
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
                 htmlEndOffset = htmlStartOffset + spanLength;
             }

            // Clamp and validate
             const htmlExprStart = locationMapping.htmlExpressionLocation.startOffset;
             const htmlExprEnd = locationMapping.htmlExpressionLocation.endOffset;
             const clampedHtmlStart = Math.max(htmlStartOffset, htmlExprStart);
             let clampedHtmlEnd = Math.min(htmlEndOffset, htmlExprEnd);
             clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);

             if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart) {
                targetRange = LSPRange.create(document.positionAt(clampedHtmlStart), document.positionAt(clampedHtmlEnd));
            } else {
                log('warn', `[onRenameRequest] Invalid mapped HTML range [${clampedHtmlStart}-${clampedHtmlEnd}] for virtual location [${virtualStart}-${virtualEnd}]`);
                continue;
            }
        } else {
            // Case 3: Location is in some other TS file
             const program = languageService.getProgram();
             const otherSourceFile = program?.getSourceFile(targetFsPathRaw);
             if (otherSourceFile) {
                 const startPos = ts.getLineAndCharacterOfPosition(otherSourceFile, virtualStart);
                 const endPos = ts.getLineAndCharacterOfPosition(otherSourceFile, virtualEnd);
                 targetRange = LSPRange.create(startPos.line, startPos.character, endPos.line, endPos.character);
             }
        }

        if (targetRange) {
             if (!editsByUri.has(targetUri)) {
                 editsByUri.set(targetUri, []);
             }
             editsByUri.get(targetUri)?.push(TextEdit.replace(targetRange, newName));
        }
    }

    if (editsByUri.size === 0) {
        log('info', "[onRenameRequest] No mappable locations found after processing TS results.");
        return undefined;
    }

    // --- Create documentChanges array --- 
    // Using documentChanges is preferred over changes
    const documentChanges: TextDocumentEdit[] = [];
    for (const [uri, edits] of editsByUri.entries()) {
        let docVersion: number | null = null;
        // Get version only if the document is open, otherwise LSP client might handle it
        const openDoc = documents.get(uri);
        if (openDoc) {
            docVersion = openDoc.version;
        }
        documentChanges.push(TextDocumentEdit.create({ uri, version: docVersion }, edits));
    }

    return { documentChanges };
} 