import * as ts from 'typescript';
import {
    SemanticTokensParams,
    SemanticTokens,
    SemanticTokensBuilder,
    SemanticTokensLegend,
    SemanticTokenTypes,
    SemanticTokenModifiers,
    Range as LSPRange
} from 'vscode-languageserver/node';
import { TextDocument, Position } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo, AureliaProjectComponentMap, Location } from '../common/types';
import { log } from '../utils/logger';

// Define the legend for semantic tokens
const tokenTypesLegend = [
    // More specific types should have LOWER index (higher priority)
    "method",        // 0
    "function",      // 1
    "property",      // 2
    "variable",      // 3
    "parameter",     // 4
    "class",         // 5 
    "type",          // 6
    "keyword",       // 7
    "operator",      // 8
    "punctuation",   // 9
    // --- Aurelia Custom Types --- 
    "aureliaElement",    // 10
    "aureliaAttribute",  // 11
    "aureliaBinding",    // 12
    "aureliaExpression"  // 13
];
const tokenModifiersLegend = [
    "declaration",
    "definition",
    "readonly"
];

// Export the legend for use in server capabilities
export const legend: SemanticTokensLegend = {
    tokenTypes: tokenTypesLegend,
    tokenModifiers: tokenModifiersLegend
};

// <<< Add decodeClassification Helper >>>
function decodeClassification(classification: number): { type: number; modifierSet: number } {
    // Type is lower 8 bits
    const type = classification & 255; 
    // Modifiers are remaining bits shifted right
    const modifierSet = classification >> 8; 
    return { type, modifierSet };
}
// <<< End Helper >>>

/** Helper to get priority (lower is better) */
function getTokenTypePriority(typeIndex: number): number {
    // Lower index in our legend means higher priority
    return typeIndex !== -1 ? typeIndex : 999; // Assign low priority if not found
}

/**
 * Handles semantic tokens requests.
 */
export async function handleSemanticTokensRequest(
    params: SemanticTokensParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    virtualFiles: Map<string, { content: string; version: number }>,
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap
): Promise<SemanticTokens> {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    const docInfo = aureliaDocuments.get(uri);

    if (!document || !docInfo || !languageService) {
        return { data: [] };
    }

    log('debug', `[semanticTokens] Request for ${uri}`);
    log('debug', `[semanticTokens] Using legend token types: ${JSON.stringify(legend.tokenTypes)}`);
    const builder = new SemanticTokensBuilder();
    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    
    // Get Aurelia-specific token type indices
    const aureliaElementTypeIndex = tokenTypesLegend.indexOf("aureliaElement");
    const aureliaAttributeTypeIndex = tokenTypesLegend.indexOf("aureliaAttribute");
    const aureliaExpressionTypeIndex = legend.tokenTypes.indexOf('aureliaExpression');
    log('debug', `[semanticTokens] Index for 'aureliaExpression': ${aureliaExpressionTypeIndex}`);

    // Set to track ranges covered by specific Aurelia tokens to avoid overlap
    const customTokenRanges = new Set<string>();

    // +++ 1. Push Custom Element/Attribute Tokens FIRST +++
    if (docInfo.elementTagLocations) {
        log('debug', `[semanticTokens] Pushing custom element/attribute tag tokens`);
        try {
            for (const tag of docInfo.elementTagLocations) {
                const componentInfo = aureliaProjectComponents.get(tag.name);
                let targetTypeIndex = -1;
                if (componentInfo?.type === 'element' && aureliaElementTypeIndex !== -1) {
                    targetTypeIndex = aureliaElementTypeIndex;
                } else if (componentInfo?.type === 'attribute' && aureliaAttributeTypeIndex !== -1) {
                    targetTypeIndex = aureliaAttributeTypeIndex;
                }
                
                if (targetTypeIndex !== -1) { 
                    // --- Push Start Tag Token ---
                    const startTagStartOffset = tag.startTagRange.startOffset;
                    const startTagEndOffset = tag.startTagRange.endOffset;
                    const startTagText = document.getText().substring(startTagStartOffset, startTagEndOffset);
                    const startTagNameIndex = startTagText.indexOf(tag.name);

                    if (startTagNameIndex !== -1) {
                        const tagNameLength = tag.name.length;
                        const tagNameStartOffset = startTagStartOffset + startTagNameIndex;
                        if (tagNameLength > 0) {
                            const startPos: Position = document.positionAt(tagNameStartOffset);
                            const rangeString = `${startPos.line}:${startPos.character}:${tagNameLength}`;
                            builder.push(startPos.line, startPos.character, tagNameLength, targetTypeIndex, 0);
                            customTokenRanges.add(rangeString); // Mark this range as covered
                            log('debug', `[semanticTokens] Pushed custom START tag token: \"${tag.name}\" at ${rangeString}`);
                        }
                    }
                    
                    // --- Push End Tag Token (if element) ---
                    if (componentInfo?.type === 'element' && tag.endTagRange) {
                        const endTagStartOffset = tag.endTagRange.startOffset;
                        const endTagEndOffset = tag.endTagRange.endOffset;
                        const endTagText = document.getText().substring(endTagStartOffset, endTagEndOffset);
                        const endTagNameIndex = endTagText.indexOf(tag.name);

                        if (endTagNameIndex === 2) { 
                            const tagNameLength = tag.name.length;
                            const tagNameStartOffset = endTagStartOffset + endTagNameIndex;
                            if (tagNameLength > 0) {
                                const startPos: Position = document.positionAt(tagNameStartOffset);
                                const rangeString = `${startPos.line}:${startPos.character}:${tagNameLength}`;
                                builder.push(startPos.line, startPos.character, tagNameLength, targetTypeIndex, 0);
                                customTokenRanges.add(rangeString); // Mark this range as covered
                                log('debug', `[semanticTokens] Pushed custom END tag token: \"${tag.name}\" at ${rangeString}`);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            log('error', `[semanticTokens] Error during preemptive custom tag push: ${e}`)
        }
    }

    // +++ 2. Push Interpolation Delimiter Tokens +++
    if (aureliaExpressionTypeIndex !== -1) {
        log('debug', `[semanticTokens] Processing interpolation delimiters (type index: ${aureliaExpressionTypeIndex})`);
        docInfo.mappings.forEach(mapping => {
            if (mapping.type === 'interpolation') {
                log('debug', `[semanticTokens] Found interpolation mapping: HTML [${mapping.htmlExpressionLocation.startOffset}-${mapping.htmlExpressionLocation.endOffset}]`);
                // ${ 
                const startOffset = mapping.htmlExpressionLocation.startOffset - 2;
                if (startOffset >= 0) { 
                    const startPos = document.positionAt(startOffset);
                    log('debug', `[semanticTokens] Pushing ${tokenTypesLegend[aureliaExpressionTypeIndex]} for \`$\` at ${startPos.line}:${startPos.character}`);
                    builder.push(startPos.line, startPos.character, 2, aureliaExpressionTypeIndex, 0);
                } else {
                    log('warn', `[Semantic Tokens] Calculated negative start offset for interpolation punctuation: ${startOffset}`);
                }
                // }
                const endOffset = mapping.htmlExpressionLocation.endOffset;
                if (endOffset <= document.getText().length) { 
                    const endPos = document.positionAt(endOffset);
                    log('debug', `[semanticTokens] Pushing ${tokenTypesLegend[aureliaExpressionTypeIndex]} for \`$\` at ${endPos.line}:${endPos.character}`);
                    builder.push(endPos.line, endPos.character, 1, aureliaExpressionTypeIndex, 0);
                } else {
                    log('warn', `[Semantic Tokens] Calculated out-of-bounds end offset for interpolation punctuation: ${endOffset}`);
                }
            }
        });
    } else {
        log('warn', `[semanticTokens] 'aureliaExpression' type index not found in legend. Skipping delimiter tokens.`);
    }

    // +++ 3. Process Mappings for Virtual File Content +++
    log('debug', `[semanticTokens] Processing virtual file content via mappings`);
    docInfo.mappings.forEach(mapping => {
        const virtualUri = docInfo.virtualUri;
        const virtualDoc = virtualFiles.get(virtualUri);
        if (!virtualDoc) return;

        try {
            const startVirtualOffset = mapping.virtualValueRange.start;
            const endVirtualOffset = mapping.virtualValueRange.end;
            const length = endVirtualOffset - startVirtualOffset;
            if (length <= 0) return;

            const virtualClassifications = languageService.getEncodedSemanticClassifications(virtualFsPath, {
                start: startVirtualOffset,
                length: length
            }, ts.SemanticClassificationFormat.TwentyTwenty);

            if (!virtualClassifications || virtualClassifications.spans.length === 0) return;

            for (let i = 0; i < virtualClassifications.spans.length; i += 3) {
                const virtualSpanStart = startVirtualOffset + virtualClassifications.spans[i];
                const virtualSpanLength = virtualClassifications.spans[i + 1];
                const virtualSpanEnd = virtualSpanStart + virtualSpanLength;
                const classification = virtualClassifications.spans[i + 2];
                const { type: tokenTypeIndex, modifierSet } = decodeClassification(classification);

                // Map virtual span back to HTML range
                let htmlStartOffset: number | undefined;
                let htmlEndOffset: number | undefined;
                const spanStartsInTransform = mapping.transformations.find(t => virtualSpanStart >= t.virtualRange.start && virtualSpanStart < t.virtualRange.end);
                const spanEndsInTransform = mapping.transformations.find(t => virtualSpanEnd > t.virtualRange.start && virtualSpanEnd <= t.virtualRange.end);

                if (spanStartsInTransform && spanStartsInTransform === spanEndsInTransform) {
                    htmlStartOffset = spanStartsInTransform.htmlRange.start;
                    htmlEndOffset = spanStartsInTransform.htmlRange.end;
                } else if (spanStartsInTransform || spanEndsInTransform) {
                    continue; // Skip tokens spanning transformations for now
                } else {
                    let accumulatedOffsetDeltaBeforeStart = 0;
                    for (const transform of mapping.transformations) {
                        if (transform.virtualRange.end <= virtualSpanStart) {
                            accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                        }
                    }
                    const baseHtmlOffset = mapping.htmlExpressionLocation.startOffset;
                    const baseVirtualOffset = mapping.virtualValueRange.start;
                    htmlStartOffset = baseHtmlOffset + (virtualSpanStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
                    htmlEndOffset = htmlStartOffset + virtualSpanLength;
                }

                if (htmlStartOffset !== undefined && htmlEndOffset !== undefined && htmlStartOffset < htmlEndOffset) {
                    const htmlExprStart = mapping.htmlExpressionLocation.startOffset;
                    const htmlExprEnd = mapping.htmlExpressionLocation.endOffset;
                    const clampedHtmlStart = Math.max(htmlStartOffset, htmlExprStart);
                    let clampedHtmlEnd = Math.min(htmlEndOffset, htmlExprEnd);
                    clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);
                    const finalLength = clampedHtmlEnd - clampedHtmlStart;

                    if (finalLength > 0) {
                        const startPos = document.positionAt(clampedHtmlStart);
                        const rangeString = `${startPos.line}:${startPos.character}:${finalLength}`;
                        if (customTokenRanges.has(rangeString)) {
                            continue; // Don't overwrite specific Aurelia element/attribute tokens
                        }
                        builder.push(startPos.line, startPos.character, finalLength, tokenTypeIndex, modifierSet);
                    }
                }
            }
        } catch (e) {
            log('error', `[semanticTokens] Error processing mapping or getting virtual tokens: ${e}`);
        }
    });

    log('info', `[semanticTokens] Built tokens for ${uri}`);
    const builtTokens = builder.build();
    return builtTokens;
}
