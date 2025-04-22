import * as ts from 'typescript';
import {
    HoverParams,
    Hover,
    MarkedString,
    Range as LSPRange
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, DetailedMapping } from '../common/types'; 
import { log } from '../utils/logger';
import { mapHtmlOffsetToVirtual } from '../core/virtualFileProvider';

/**
 * Handles hover requests.
 */
export async function handleHoverRequest(
    params: HoverParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    virtualFiles: Map<string, { content: string; version: number }>, // Need virtualFiles for mapping
    languageService: ts.LanguageService
): Promise<Hover | undefined> {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const docInfo = aureliaDocuments.get(htmlUri);
    if (!docInfo) return undefined;

    const offset = document.offsetAt(params.position);

    // --- Find Active Mapping --- 
    let activeMapping: DetailedMapping | undefined;
    for (const mapping of docInfo.mappings) {
        if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
            if (offset === mapping.htmlExpressionLocation.endOffset && mapping.htmlExpressionLocation.startOffset === mapping.htmlExpressionLocation.endOffset) continue;
            activeMapping = mapping;
            break;
        }
    }

    // --- Branch 1: Hover INSIDE an Aurelia expression --- 
    if (activeMapping) {
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
            log('debug', '[onHover] TS returned no QuickInfo.');
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
                    document.positionAt(containingTransformation.htmlRange.start),
                    document.positionAt(containingTransformation.htmlRange.end)
                );
                log('debug', `[onHover] Mapped contained virtual span [${virtualSpanStart}-${virtualSpanEnd}] to HTML range ${JSON.stringify(htmlRange)} via transformation.`);
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
                        document.positionAt(clampedHtmlStart),
                        document.positionAt(clampedHtmlEnd)
                    );
                    log('debug', `[onHover] Mapped non-contained virtual span [${virtualSpanStart}-${virtualSpanEnd}] to HTML range ${JSON.stringify(htmlRange)} using delta.`);
                } else {
                    log('warn', `[onHover] Failed to map non-contained virtual span [${virtualSpanStart}-${virtualSpanEnd}] to valid HTML range.`);
                }
            }
        } catch (e) {
            log('error', `[onHover] Error during transformation-based span mapping v2: ${e}`)
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
    // --- Branch 2: Hover OUTSIDE an Aurelia expression --- 
    else {
        log('debug', `[onHover] Offset ${offset} is outside mapped expressions.`);
        // TODO: Implement hover for HTML tags/attributes 
        return undefined; 
    }
} 