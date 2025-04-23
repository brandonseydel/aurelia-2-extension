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
import { getTagAtOffset } from '../utils/htmlParsing';
import { getWordRangeAtPosition } from '../utils/utilities';

/**
 * Handles hover requests.
 */
export async function handleHoverRequest(
    params: HoverParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap
): Promise<Hover | undefined> {
    const htmlUri = params.textDocument.uri;
    const document = documents.get(htmlUri);
    if (!document || !htmlUri.endsWith('.html')) return undefined;

    const offset = document.offsetAt(params.position);
    const docInfo = aureliaDocuments.get(htmlUri);

    // --- Find Active Mapping --- 
    let activeMapping: DetailedMapping | undefined;
    if (docInfo) {
        for (const mapping of docInfo.mappings) {
            if (mapping.htmlExpressionLocation.startOffset <= offset && offset <= mapping.htmlExpressionLocation.endOffset) {
                if (offset === mapping.htmlExpressionLocation.endOffset && mapping.htmlExpressionLocation.startOffset === mapping.htmlExpressionLocation.endOffset) continue;
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
        log('debug', `[onHover] Offset ${offset} is outside mapped expressions. Checking for tags.`);
        const text = document.getText();
        const tagInfo = await getTagAtOffset(text, offset);

        if (tagInfo) {
            log('debug', `[onHover] Found tag '${tagInfo.tagName}' at offset ${offset}. Type: ${tagInfo.type}`);
            const componentInfo = aureliaProjectComponents.get(tagInfo.tagName);

            if (componentInfo) {
                 log('debug', `[onHover] Tag '${tagInfo.tagName}' matches known component: ${componentInfo.type}`);
                 
                 // --- Calculate Hover Range --- 
                 let hoverRange: LSPRange | undefined;
                 if (tagInfo.locations) {
                     const relevantLocation = tagInfo.type === 'start' ? tagInfo.locations.startTag : tagInfo.locations.endTag;
                     if (relevantLocation) {
                         const startOffsetCorrection = tagInfo.type === 'start' ? 1 : 2;
                         const startPos = document.positionAt(relevantLocation.startOffset + startOffsetCorrection);
                         const endPos = document.positionAt(relevantLocation.startOffset + startOffsetCorrection + tagInfo.tagName.length);
                         hoverRange = LSPRange.create(startPos, endPos);
                     }
                 }
                 if (!hoverRange) {
                     const wordRange = getWordRangeAtPosition(document, params.position);
                     if (wordRange && document.getText(wordRange) === tagInfo.tagName) {
                         hoverRange = wordRange;
                     } else {
                         hoverRange = LSPRange.create(params.position, params.position); // Fallback
                     }
                 }
                 // --- End Calculate Hover Range ---

                 // --- Construct Hover Content (Enhanced) --- 
                 const markdownLines: string[] = [];
                 const componentTypeText = componentInfo.type === 'element' ? '(element)' : '(attribute)';
                 markdownLines.push(`**${componentInfo.name}** ${componentTypeText}`);
                 if (componentInfo.className) {
                     markdownLines.push(`*Class:* \`${componentInfo.className}\``);
                 }
                 if (componentInfo.sourceFile) {
                    markdownLines.push(`*From:* \`${path.basename(componentInfo.sourceFile)}\``);
                 }
                 
                 // Enhance Bindables Section
                 if (componentInfo.bindables && componentInfo.bindables.length > 0) {
                    markdownLines.push('\n--- \n**Bindables:**');
                    
                    for (const bindableName of componentInfo.bindables) {
                        // Simplified markdown line: Just name and usage sample
                        let bindableLine = `- \`${bindableName}\``;
                        bindableLine += `  \n  *Usage:* \`\\<${componentInfo.name} ${bindableName}.bind=\"...\"></${componentInfo.name}>\``;
                        markdownLines.push(bindableLine);
                    }
                 }
                 
                 const content: MarkupContent = {
                     kind: MarkupKind.Markdown,
                     value: markdownLines.join('  \n') // Double space + newline for markdown line breaks
                 };
                 // --- End Construct Hover Content --- 

                 log('info', `[onHover] Providing hover for known component '${componentInfo.name}' (bindable details simplified).`);
                 return { contents: content, range: hoverRange };
            }
        }

        log('debug', '[onHover] No active expression mapping or known tag found at offset.');
        return undefined; 
    }
} 