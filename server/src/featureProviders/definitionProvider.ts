import * as ts from 'typescript';
import {
    DefinitionParams,
    LocationLink,
    Position,
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

/**
 * Handles definition requests. 
 */
export async function handleDefinitionRequest(
    params: DefinitionParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap
): Promise<LocationLink[] | undefined> {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const offset = document.offsetAt(params.position);

    // --- Begin: Added Custom Element Tag Definition Logic ---
    const text = document.getText();
    const tagInfo = await getTagAtOffset(text, offset);

    if (tagInfo) {
        log('debug', `[onDefinition] Found tag '${tagInfo.tagName}' at offset ${offset}. Type: ${tagInfo.type}`);
        const componentInfo = aureliaProjectComponents.get(tagInfo.tagName);

        if (componentInfo?.type === 'element' && componentInfo.uri) {
            log('debug', `[onDefinition] Found custom element definition for '${tagInfo.tagName}' at URI: ${componentInfo.uri}`);

            const targetUri = componentInfo.uri;
            // Target the start of the document for now. Ideally, we'd find the class declaration.
            const targetRange = LSPRange.create(0, 0, 0, 0); // Full document range
            const targetSelectionRange = LSPRange.create(0, 0, 0, 0); // Select start of file

            // Calculate the origin range (the tag itself in the HTML)
            let originSelectionRange: LSPRange | undefined;
            if (tagInfo.locations) {
                 // Use the precise location of the tag name (opening or closing)
                 const relevantLocation = tagInfo.type === 'start' ? tagInfo.locations.startTag : tagInfo.locations.endTag;
                 if (relevantLocation) {
                     // +1 for start tag (<tag), +2 for end tag (</tag)
                     const startOffsetCorrection = tagInfo.type === 'start' ? 1 : 2;
                     const startPos = document.positionAt(relevantLocation.startOffset + startOffsetCorrection);
                     const endPos = document.positionAt(relevantLocation.startOffset + startOffsetCorrection + tagInfo.tagName.length);
                     originSelectionRange = LSPRange.create(startPos, endPos);
                 }
            }

            // Fallback origin range if precise location failed (e.g., parser issue or malformed HTML)
             if (!originSelectionRange) {
                  log('warn', `[onDefinition] Could not get precise location for tag '${tagInfo.tagName}' from parser. Using fallback range.`);
                 // Use imported helper
                 const wordRange = getWordRangeAtPosition(document, params.position);
                 if (wordRange && document.getText(wordRange) === tagInfo.tagName) {
                    originSelectionRange = wordRange;
                 } else {
                    originSelectionRange = LSPRange.create(params.position, params.position);
                 }
             }

            return [
                LocationLink.create(targetUri, targetRange, targetSelectionRange, originSelectionRange)
            ];
        } else {
             log('debug', `[onDefinition] Tag '${tagInfo.tagName}' found, but it's not a known custom element or has no URI.`);
        }
    }
     // --- End: Added Custom Element Tag Definition Logic ---

    // Original logic for definitions within expressions
    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) {
         // If we didn't find a tag and there's no docInfo, exit
         log('debug', `[onDefinition] Offset ${offset} not on a known tag and no AureliaDocumentInfo found.`);
         return undefined;
    }

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
        log('debug', `[onDefinition] Offset ${offset} not within any mapped expression (and not a known custom element tag).`);
        return undefined; // Return undefined if not a tag and not in an expression
    }

    // --- Original logic continues below ---
    let virtualDefinitionOffset = mapHtmlOffsetToVirtual(offset, activeMapping);
    log('debug', `[onDefinition] Mapped HTML Offset: ${offset} to Virtual Offset: ${virtualDefinitionOffset} in ${docInfo.virtualUri}`);

    // Get definition from TS Language Service
    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    let definitionInfo: ts.DefinitionInfoAndBoundSpan | undefined;
    try {
        definitionInfo = languageService.getDefinitionAndBoundSpan(virtualFsPath, virtualDefinitionOffset);
    } catch (e) {
        log('error', `[onDefinition] Error getting definition from TS: ${e}`);
        return undefined;
    }
    
    if (!definitionInfo || !definitionInfo.definitions || definitionInfo.definitions.length === 0) {
        log('debug', "[onDefinition] TS returned no definitions for expression.");
        return undefined;
    }

    const locationLinks: LocationLink[] = [];
    const program = languageService.getProgram(); 

    // --- Calculate Origin Span (HTML Highlighting using Transformations) ---
    const originVirtualSpan = definitionInfo.textSpan; 
    const virtualSpanStart = originVirtualSpan.start;
    const virtualSpanEnd = virtualSpanStart + originVirtualSpan.length;
    let originSelectionRangeFromExpression: LSPRange | undefined;

    try {
        // Find the specific transformation that *contains* or *matches* the virtualSpan start
        const containingTransformation = activeMapping.transformations.find(t => 
            virtualSpanStart >= t.virtualRange.start && virtualSpanStart < t.virtualRange.end
        );

        if (containingTransformation) {
            // Case 1: The span starts within a transformed identifier's range (_this.xxx)
            originSelectionRangeFromExpression = LSPRange.create(
                document.positionAt(containingTransformation.htmlRange.start),
                document.positionAt(containingTransformation.htmlRange.end)
            );
            log('debug', `[onDefinition] Mapped expression origin virtual span [${virtualSpanStart}-${virtualSpanEnd}] to HTML range ${JSON.stringify(originSelectionRangeFromExpression)} via transformation.`);
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
                 originSelectionRangeFromExpression = LSPRange.create(
                    document.positionAt(clampedHtmlStart),
                    document.positionAt(clampedHtmlEnd)
                );
                log('debug', `[onDefinition] Mapped non-contained expression origin virtual span [${virtualSpanStart}-${virtualSpanEnd}] to HTML range ${JSON.stringify(originSelectionRangeFromExpression)}.`);
            } else {
                log('warn', `[onDefinition] Failed to map expression origin virtual span [${virtualSpanStart}-${virtualSpanEnd}] to valid HTML range.`);
                 // Fallback: highlight the whole expression if mapping fails
                 originSelectionRangeFromExpression = LSPRange.create(
                     document.positionAt(activeMapping.htmlExpressionLocation.startOffset),
                     document.positionAt(activeMapping.htmlExpressionLocation.endOffset)
                 );
            }
        }
    } catch (e) {
        log('error', `[onDefinition] Error mapping origin span for expression: ${e}`);
         originSelectionRangeFromExpression = LSPRange.create(
             document.positionAt(activeMapping.htmlExpressionLocation.startOffset),
             document.positionAt(activeMapping.htmlExpressionLocation.endOffset)
         );
    }
    // --- End Origin Span Calculation ---

    if (!originSelectionRangeFromExpression) {
        log('error', '[onDefinition] Failed to determine originSelectionRange for expression, using fallback.');
        originSelectionRangeFromExpression = LSPRange.create(
            document.positionAt(activeMapping.htmlExpressionLocation.startOffset),
            document.positionAt(activeMapping.htmlExpressionLocation.endOffset)
        );
    }

    for (const def of definitionInfo.definitions) {
        // Avoid mapping back to the virtual file itself
        if (def.fileName === virtualFsPath) { // Check against virtualFsPath
             log('debug', `[onDefinition] Skipping definition that points back to the virtual file: ${def.fileName}`);
             continue;
         }

        const targetUri = URI.file(def.fileName).toString();
        const targetSourceFile = program?.getSourceFile(def.fileName); 

        if (!targetSourceFile) {
             log('warn', `[onDefinition] Could not get source file for expression definition target: ${def.fileName}`);
             continue; 
        }

        const targetStartPos = ts.getLineAndCharacterOfPosition(targetSourceFile, def.textSpan.start);
        const targetEndPos = ts.getLineAndCharacterOfPosition(targetSourceFile, def.textSpan.start + def.textSpan.length);
        const targetRange = LSPRange.create(targetStartPos.line, targetStartPos.character, targetEndPos.line, targetEndPos.character);
        const targetSelectionRange = LSPRange.create(targetStartPos.line, targetStartPos.character, targetStartPos.line, targetStartPos.character);

        locationLinks.push(
            LocationLink.create(targetUri, targetRange, targetSelectionRange, originSelectionRangeFromExpression)
        );
    }

    if (locationLinks.length > 0) {
         log('info', `[onDefinition] Returning ${locationLinks.length} mapped LocationLinks from expression.`);
    } else {
         log('debug', '[onDefinition] No valid LocationLinks generated from expression definition.');
    }

    return locationLinks.length > 0 ? locationLinks : undefined;
} 