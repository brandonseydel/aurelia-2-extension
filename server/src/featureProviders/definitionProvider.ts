import * as ts from 'typescript';
import {
    DefinitionParams,
    LocationLink,
    Range as LSPRange
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping } from '../common/types'; 
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';

/**
 * Handles definition requests. 
 */
export async function handleDefinitionRequest(
    params: DefinitionParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService
): Promise<LocationLink[] | undefined> {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const offset = document.offsetAt(params.position);

    // Find the active mapping
    let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
            // Allow definition at the end char if expression isn't empty
            if (offset === mapping.htmlExpressionLocation.endOffset && mapping.htmlExpressionLocation.startOffset === mapping.htmlExpressionLocation.endOffset) {
                continue;
            }
             activeMapping = mapping;
             break;
         }
    }

    if (!activeMapping) {
        log('debug', `[onDefinition] Offset ${offset} not within any mapped expression for definition.`);
        return undefined;
    }

    let virtualDefinitionOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
    log('debug', `[onDefinition] Mapped HTML Offset: ${offset} to Virtual Offset: ${virtualDefinitionOffset} in ${docInfo.virtualUri}`);

    // Get definition from TS Language Service
    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    let definitionInfo: ts.DefinitionInfoAndBoundSpan | undefined;
    try {
        definitionInfo = languageService.getDefinitionAndBoundSpan(virtualFsPath, virtualDefinitionOffset);
    } catch (e) {
        log('error', `[onDefinition] Error getting definition: ${e}`);
        return undefined;
    }
    
    if (!definitionInfo || !definitionInfo.definitions || definitionInfo.definitions.length === 0) {
        log('debug', "[onDefinition] TS returned no definitions.");
        return undefined;
    }

    const locationLinks: LocationLink[] = [];
    const program = languageService.getProgram(); 

    // --- Calculate Origin Span (HTML Highlighting using Transformations) ---
    const originVirtualSpan = definitionInfo.textSpan; 
    const virtualSpanStart = originVirtualSpan.start;
    const virtualSpanEnd = virtualSpanStart + originVirtualSpan.length;
    let originSelectionRange: LSPRange | undefined;

    try {
        // Find the specific transformation that *contains* or *matches* the virtualSpan start
        const containingTransformation = activeMapping.transformations.find(t => 
            virtualSpanStart >= t.virtualRange.start && virtualSpanStart < t.virtualRange.end
        );

        if (containingTransformation) {
            // Case 1: The span starts within a transformed identifier's range (_this.xxx)
            originSelectionRange = LSPRange.create(
                document.positionAt(containingTransformation.htmlRange.start),
                document.positionAt(containingTransformation.htmlRange.end)
            );
            log('debug', `[onDefinition] Mapped origin virtual span [${virtualSpanStart}-${virtualSpanEnd}] to HTML range ${JSON.stringify(originSelectionRange)} via transformation.`);
        } else {
            // Case 2: The span is NOT within a transformed identifier range
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
                 originSelectionRange = LSPRange.create(
                    document.positionAt(clampedHtmlStart),
                    document.positionAt(clampedHtmlEnd)
                );
                log('debug', `[onDefinition] Mapped non-contained origin virtual span [${virtualSpanStart}-${virtualSpanEnd}] to HTML range ${JSON.stringify(originSelectionRange)}.`);
            } else {
                log('warn', `[onDefinition] Failed to map origin virtual span [${virtualSpanStart}-${virtualSpanEnd}] to valid HTML range.`);
                 // Fallback: highlight the whole expression if mapping fails
                 originSelectionRange = LSPRange.create(
                     document.positionAt(activeMapping.htmlExpressionLocation.startOffset),
                     document.positionAt(activeMapping.htmlExpressionLocation.endOffset)
                 );
            }
        }
    } catch (e) {
        log('error', `[onDefinition] Error mapping origin span: ${e}`);
         originSelectionRange = LSPRange.create(
             document.positionAt(activeMapping.htmlExpressionLocation.startOffset),
             document.positionAt(activeMapping.htmlExpressionLocation.endOffset)
         );
    }
    // --- End Origin Span Calculation ---

    if (!originSelectionRange) { 
        log('error', '[onDefinition] Failed to determine originSelectionRange, using fallback.');
        originSelectionRange = LSPRange.create(
            document.positionAt(activeMapping.htmlExpressionLocation.startOffset),
            document.positionAt(activeMapping.htmlExpressionLocation.endOffset)
        );
    }

    for (const def of definitionInfo.definitions) {
        if (def.fileName === docInfo.virtualUri) continue;

        const targetUri = URI.file(def.fileName).toString();
        const targetSourceFile = program?.getSourceFile(def.fileName); 

        if (!targetSourceFile) {
             log('warn', `[onDefinition] Could not get source file for definition target: ${def.fileName}`);
             continue; 
        }

        const targetStartPos = ts.getLineAndCharacterOfPosition(targetSourceFile, def.textSpan.start);
        const targetEndPos = ts.getLineAndCharacterOfPosition(targetSourceFile, def.textSpan.start + def.textSpan.length);
        const targetRange = LSPRange.create(targetStartPos.line, targetStartPos.character, targetEndPos.line, targetEndPos.character);
        const targetSelectionRange = LSPRange.create(targetStartPos.line, targetStartPos.character, targetStartPos.line, targetStartPos.character);

        locationLinks.push(
            LocationLink.create(targetUri, targetRange, targetSelectionRange, originSelectionRange)
        );
    }

    log('info', `[onDefinition] Returning ${locationLinks.length} mapped LocationLinks.`);
    return locationLinks;
} 