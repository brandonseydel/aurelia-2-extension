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
    // "aureliaBinding", // Maybe later, focus on elements/attrs first
    // Add others as needed
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
    virtualFiles: Map<string, { content: string; version: number }>, // Need virtualFiles for mapping
    languageService: ts.LanguageService,
    aureliaProjectComponents: AureliaProjectComponentMap // <<< Add the component map parameter
): Promise<SemanticTokens> {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    const docInfo = aureliaDocuments.get(uri);

    if (!document || !docInfo || !languageService) {
        return { data: [] }; // Return empty tokens if document/info/service not available
    }

    log('debug', `[semanticTokens] Request for ${uri}`);
    const builder = new SemanticTokensBuilder();
    const virtualFsPath = URI.parse(docInfo.virtualUri).fsPath;
    
    try {
        log('debug', `[semanticTokens] Getting classifications for: ${virtualFsPath}`);
        const classifications = languageService.getEncodedSemanticClassifications(virtualFsPath, {
            start: 0,
            length: virtualFiles.get(docInfo.virtualUri)?.content.length ?? 0
        }, ts.SemanticClassificationFormat.TwentyTwenty);

        if (!classifications || classifications.spans.length === 0) {
            log('warn', `[semanticTokens] No classifications returned from TS for ${virtualFsPath}`);
            return { data: [] };
        }

        log('info', `[semanticTokens] Received ${classifications.spans.length / 3} encoded spans from TS.`);

        // <<< Remove classTokenTypeIndex, get Aurelia indices >>>
        // const classTokenTypeIndex = legend.tokenTypes.indexOf("class"); 
        const aureliaElementTypeIndex = tokenTypesLegend.indexOf("aureliaElement");
        const aureliaAttributeTypeIndex = tokenTypesLegend.indexOf("aureliaAttribute");

        // +++ Create Set of ranges occupied by custom element/attribute tag names +++
        const customTagNameRanges = new Set<string>(); // Renamed for clarity
        if (docInfo.elementTagLocations) {
            for (const tag of docInfo.elementTagLocations) {
                const componentInfo = aureliaProjectComponents.get(tag.name);
                // <<< Check for element OR attribute >>>
                if (componentInfo && (componentInfo.type === 'element' || componentInfo.type === 'attribute')) {
                    // --- Process Start Tag ---
                    try {
                        const startTagStartOffset = tag.startTagRange.startOffset;
                        const startTagEndOffset = tag.startTagRange.endOffset;
                        const startTagText = document.getText().substring(startTagStartOffset, startTagEndOffset);
                        const tagNameIndex = startTagText.indexOf(tag.name);

                        if (tagNameIndex !== -1) {
                            const tagNameLength = tag.name.length;
                            const tagNameStartOffset = startTagStartOffset + tagNameIndex;
                            const length = tagNameLength;
                            
                            if (length > 0) {
                                const startPos = document.positionAt(tagNameStartOffset);
                                const rangeString = `${startPos.line}:${startPos.character}:${length}`;
                                customTagNameRanges.add(rangeString);
                                log('debug', `[semanticTokens] Pre-calculated custom START TAG NAME range: ${tag.name} at ${rangeString}`);
                            }
                        } else {
                            log('warn', `[semanticTokens] Pre-calc: Could not find start tag name "${tag.name}" within start tag text: "${startTagText}"`);
                        }
                    } catch(e) {
                         log('error', `[semanticTokens] Error pre-calculating start tag range for "${tag.name}": ${e}`);
                    }

                    // --- Process End Tag (if it exists, for elements) ---
                    if (componentInfo && componentInfo.type === 'element' && tag.endTagRange) {
                         try {
                            const endTagStartOffset = tag.endTagRange.startOffset;
                            const endTagEndOffset = tag.endTagRange.endOffset;
                            const endTagText = document.getText().substring(endTagStartOffset, endTagEndOffset);
                            // Tag name starts after '</'
                            const tagNameIndex = endTagText.indexOf(tag.name);

                            if (tagNameIndex !== -1 && tagNameIndex === 2) { // Ensure it follows </
                                const tagNameLength = tag.name.length;
                                const tagNameStartOffset = endTagStartOffset + tagNameIndex;
                                const length = tagNameLength;
                                
                                if (length > 0) {
                                    const startPos = document.positionAt(tagNameStartOffset);
                                    const rangeString = `${startPos.line}:${startPos.character}:${length}`;
                                    customTagNameRanges.add(rangeString);
                                    log('debug', `[semanticTokens] Pre-calculated custom END TAG NAME range: ${tag.name} at ${rangeString}`);
                                }
                            } else {
                                log('warn', `[semanticTokens] Pre-calc: Could not find end tag name "${tag.name}" at expected position in end tag text: "${endTagText}"`);
                            }
                        } catch(e) {
                            log('error', `[semanticTokens] Error pre-calculating end tag range for "${tag.name}": ${e}`);
                        }
                    }
                }
            }
        }
        log('debug', `[semanticTokens] Found ${customTagNameRanges.size} specific custom tag name ranges (start/end).`);
        // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

        // +++ Push Custom Element/Attribute Tokens FIRST +++
        if (docInfo.elementTagLocations) {
            log('debug', `[semanticTokens] >>> Running Preemptive Custom Token Push <<<`);
            try {
                for (const tag of docInfo.elementTagLocations) {
                    const componentInfo = aureliaProjectComponents.get(tag.name);
                    // <<< Determine correct Aurelia type index >>>
                    let targetTypeIndex = -1;
                    if (componentInfo && componentInfo.type === 'element' && aureliaElementTypeIndex !== -1) {
                        targetTypeIndex = aureliaElementTypeIndex;
                    } else if (componentInfo && componentInfo.type === 'attribute' && aureliaAttributeTypeIndex !== -1) {
                        targetTypeIndex = aureliaAttributeTypeIndex;
                    }
                    
                    if (targetTypeIndex !== -1) { // If it's a known Aurelia element or attribute
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
                                 log('debug', `[semanticTokens] Preemptive Push: Pushing '${tokenTypesLegend[targetTypeIndex]}' token for START tag "${tag.name}" at ${startPos.line}:${startPos.character} (Length: ${tagNameLength})`);
                                 builder.push(startPos.line, startPos.character, tagNameLength, targetTypeIndex, 0);
                             }
                         }
                        
                         // --- Push End Tag Token (if element) ---
                         if (componentInfo && componentInfo.type === 'element' && tag.endTagRange) {
                             const endTagStartOffset = tag.endTagRange.startOffset;
                             const endTagEndOffset = tag.endTagRange.endOffset;
                             const endTagText = document.getText().substring(endTagStartOffset, endTagEndOffset);
                             const endTagNameIndex = endTagText.indexOf(tag.name); // Should be 2

                             if (endTagNameIndex === 2) { // Check it starts after </
                                 const tagNameLength = tag.name.length;
                                 const tagNameStartOffset = endTagStartOffset + endTagNameIndex;
                                 if (tagNameLength > 0) {
                                     const startPos: Position = document.positionAt(tagNameStartOffset);
                                     log('debug', `[semanticTokens] Preemptive Push: Pushing '${tokenTypesLegend[targetTypeIndex]}' token for END tag "${tag.name}" at ${startPos.line}:${startPos.character} (Length: ${tagNameLength})`);
                                     builder.push(startPos.line, startPos.character, tagNameLength, targetTypeIndex, 0);
                                 }
                             }
                         }
                    }
                }
            } catch (e) {
                log('error', `[semanticTokens] Error during preemptive custom tag push: ${e}`)
            }
        }
        // +++ End Preemptive Custom Token Push +++

        // <<< Initialize Map for TS-based tokens >>>
        const tsBasedTokens = new Map<string, { typeIndex: number; modifierSet: number }>();

        // <<< First Pass (Processing TS Classifications) >>>
        log('debug', `[semanticTokens] >>> Starting First Pass (TS Classification) <<<`);
        for (let i = 0; i < classifications.spans.length; i += 3) {
            const virtualStart = classifications.spans[i];
            const virtualLength = classifications.spans[i + 1];
            const classification = classifications.spans[i + 2];
            const virtualEnd = virtualStart + virtualLength;

            const decoded = decodeToken(classification);
            if (!decoded) continue; // Skip if TS classification is unknown to us

            // --- Map Virtual Span back to HTML Range --- 
            for (const mapping of docInfo.mappings) {
                let mapped = false;
                if (mapping.virtualValueRange.start <= virtualStart && virtualEnd <= mapping.virtualValueRange.end) {
                    let htmlStartOffset: number;
                    let htmlEndOffset: number;
                    
                    // Find the specific transformation containing the start, if any
                    const containingTransformation = mapping.transformations.find(t => 
                        virtualStart >= t.virtualRange.start && virtualStart < t.virtualRange.end
                    );

                    if (containingTransformation) {
                        // Case 1: Span starts within a transformed identifier
                        // Map back to the original HTML identifier range
                        htmlStartOffset = containingTransformation.htmlRange.start;
                        htmlEndOffset = containingTransformation.htmlRange.end; 
                        // Adjust end based on virtual length relative to transformation start?
                        // This simplified approach maps the whole original identifier.
                    } else {
                        // Case 2: Span is not within a transformed identifier
                        let accumulatedOffsetDeltaBeforeStart = 0;
                        for (const transform of mapping.transformations) {
                            if (transform.virtualRange.end <= virtualStart) {
                                accumulatedOffsetDeltaBeforeStart += transform.offsetDelta;
                            }
                        }
                        const baseHtmlOffset = mapping.htmlExpressionLocation.startOffset;
                        const baseVirtualOffset = mapping.virtualValueRange.start;
                        htmlStartOffset = baseHtmlOffset + (virtualStart - baseVirtualOffset) - accumulatedOffsetDeltaBeforeStart;
                        const spanLength = virtualEnd - virtualStart; 
                        htmlEndOffset = htmlStartOffset + spanLength;
                    }

                    // Clamp and validate
                    const htmlExprStart = mapping.htmlExpressionLocation.startOffset;
                    const htmlExprEnd = mapping.htmlExpressionLocation.endOffset;
                    const clampedHtmlStart = Math.max(htmlStartOffset, htmlExprStart);
                    let clampedHtmlEnd = Math.min(htmlEndOffset, htmlExprEnd);
                    clampedHtmlEnd = Math.max(clampedHtmlStart, clampedHtmlEnd);

                    if (clampedHtmlStart <= htmlExprEnd && clampedHtmlEnd >= clampedHtmlStart) {
                        const startPos = document.positionAt(clampedHtmlStart);
                        const endPos = document.positionAt(clampedHtmlEnd);
                        let line = startPos.line;
                        let startChar = startPos.character;
                        let length = 0;
                        let tokenText = ""; // <<< Get token text

                        if (line === endPos.line) {
                            length = endPos.character - startPos.character;
                        } else {
                            // For multi-line tokens, accurately calculate length based on text content
                            tokenText = document.getText().substring(clampedHtmlStart, clampedHtmlEnd);
                            length = tokenText.length; 
                        }
                        // Get single-line token text if not already fetched
                        if (!tokenText && length > 0) {
                            tokenText = document.getText().substring(clampedHtmlStart, clampedHtmlEnd); 
                        }

                        if (length > 0) {
                            const currentRangeString = `${line}:${startChar}:${length}`;
                            // <<< Use renamed customTagNameRanges set >>>
                            const isCustomTagRange = customTagNameRanges.has(currentRangeString);

                            // <<< Skip if handled by preemptive push >>>
                            if (isCustomTagRange) {
                                log('debug', `[semanticTokens] Pass 1: Skipping range ${currentRangeString} ("${tokenText}") - Handled by preemptive push.`);
                                continue; // Skip to next mapping
                            }
                            
                            // <<< Update map with the BEST token type found for this range >>>
                            const existingTokenData = tsBasedTokens.get(currentRangeString);
                            if (existingTokenData) {
                                // If new token has higher priority (lower index), replace
                                if (getTokenTypePriority(decoded.typeIndex) < getTokenTypePriority(existingTokenData.typeIndex)) {
                                    log('debug', `[semanticTokens] Pass 1: Updating token for range ${currentRangeString}. New type ${tokenTypesLegend[decoded.typeIndex]} (priority ${getTokenTypePriority(decoded.typeIndex)}) is better than old type ${tokenTypesLegend[existingTokenData.typeIndex]} (priority ${getTokenTypePriority(existingTokenData.typeIndex)}).`);
                                    tsBasedTokens.set(currentRangeString, { typeIndex: decoded.typeIndex, modifierSet: decoded.modifierSet });
                                }
                            } else {
                                // First time seeing this range, add it
                                 log('debug', `[semanticTokens] Pass 1: Adding initial token for range ${currentRangeString}. Type: ${tokenTypesLegend[decoded.typeIndex]} (priority ${getTokenTypePriority(decoded.typeIndex)}).`);
                                tsBasedTokens.set(currentRangeString, { typeIndex: decoded.typeIndex, modifierSet: decoded.modifierSet });
                            }
                            // <<< End map update logic >>>
                        }
                    }
                }
            } // End inner mapping loop
        } // <<< End of First Pass Loop >>>

        // +++ Push collected TS Tokens AFTER preemptive custom tokens +++
        log('debug', `[semanticTokens] >>> Pushing ${tsBasedTokens.size} prioritized TS-based tokens <<<`);
        for (const [rangeString, tokenData] of tsBasedTokens.entries()) {
             try {
                const [lineStr, charStr, lenStr] = rangeString.split(':');
                const line = parseInt(lineStr, 10);
                const startChar = parseInt(charStr, 10);
                const length = parseInt(lenStr, 10);

                if (!isNaN(line) && !isNaN(startChar) && !isNaN(length) && length > 0) {
                    log('debug', `[semanticTokens] Final Push: Pushing token at ${line}:${startChar} (Length: ${length}, Type: ${tokenTypesLegend[tokenData.typeIndex]}, Modifiers: ${tokenData.modifierSet})`);
                    builder.push(line, startChar, length, tokenData.typeIndex, tokenData.modifierSet);

                    // +++ Check if it was a method/function and push () tokens +++
                    const methodTypeIndex = tokenTypesLegend.indexOf("method"); // Use string
                    const functionTypeIndex = tokenTypesLegend.indexOf("function"); // Use string
                    const punctuationTypeIndex = tokenTypesLegend.indexOf("punctuation"); // Use string
                    
                    if ((tokenData.typeIndex === methodTypeIndex || tokenData.typeIndex === functionTypeIndex) && punctuationTypeIndex !== -1) {
                        try {
                            const endOffset = document.offsetAt({ line: line, character: startChar + length });
                            const nextChars = document.getText().substring(endOffset, endOffset + 2);
                            
                            if (nextChars === '()') {
                                const openParenPos = document.positionAt(endOffset);
                                const closeParenPos = document.positionAt(endOffset + 1);
                                log('debug', `[semanticTokens] Final Push: Adding punctuation tokens for () after method/function.`);
                                // Push '(' token
                                builder.push(openParenPos.line, openParenPos.character, 1, punctuationTypeIndex, 0);
                                // Push ')' token
                                builder.push(closeParenPos.line, closeParenPos.character, 1, punctuationTypeIndex, 0); 
                            }
                        } catch (e) {
                            log('warn', `[semanticTokens] Final Push: Error checking/pushing parentheses tokens: ${e}`);
                        }
                    }
                    // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
                } else {
                    log('warn', `[semanticTokens] Final Push: Skipping invalid range string: ${rangeString}`);
                }
            } catch (e) {
                log('error', `[semanticTokens] Final Push: Error processing range string ${rangeString}: ${e}`);
            }
        }
        // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

        // --- Ensure original second pass remains commented out --- 
        /* 
        log('debug', `[semanticTokens] Checking for elementTagLocations...`);
        if (docInfo.elementTagLocations) { ... }
        */

    } catch (e) {
        log('error', `[semanticTokens] Error getting semantic classifications: ${e}`);
        return { data: [] };
    }

    log('info', `[semanticTokens] Built tokens for ${uri}`);

    const builtTokens = builder.build();
    log('debug', `[semanticTokens] Final built data: ${JSON.stringify(builtTokens.data)}`); // <<< Log the raw data array
    return builtTokens;
}


/**
 * Helper to decode TS Semantic Classification
 * IMPORTANT: This relies on internal TS classification types/values which might change.
 */
function decodeToken(classification: number): { typeIndex: number; modifierSet: number } | undefined {
    // +++ Log raw classification +++
    log('debug', `[decodeToken] Received raw classification: ${classification}`);
    // +++++++++++++++++++++++++++++++

    const semanticClassificationFormatShift = 8;
    // Hardcoding common values as enum members might vary
    const classificationTypeMethodName = 11;
    const classificationTypeFunctionName = 10;
    const classificationTypePropertyName = 9;
    const classificationTypeVariableName = 7;
    const classificationTypeClassName = 1; // Added based on usage below
    const classificationTypeInterfaceName = 3; // Added based on usage below
    const classificationTypeEnumName = 2; // Added based on usage below
    const classificationTypeModuleName = 4; // Added based on usage below
    const classificationTypeTypeAliasName = 5; // Added based on usage below
    const classificationTypeTypeParameterName = 6; // Added based on usage below
    const classificationTypeParameterName = 8; // Added based on usage below
    const classificationTypeKeyword = 13; // Added based on usage below
    const classificationTypeIdentifier = 20; // Added based on usage below

    if (classification > semanticClassificationFormatShift) {
        const type = (classification >> semanticClassificationFormatShift) - 1;
        const modifier = classification & ((1 << semanticClassificationFormatShift) - 1);

        let typeIndex: number | undefined = undefined;
        switch (type) {
            case classificationTypeMethodName: // 11
                typeIndex = legend.tokenTypes.indexOf("method");
                break;
            case classificationTypeFunctionName: // 10
                typeIndex = legend.tokenTypes.indexOf("function");
                break;
            case classificationTypePropertyName: // 9
                typeIndex = legend.tokenTypes.indexOf("property");
                break;
            case classificationTypeVariableName: // 7
                typeIndex = legend.tokenTypes.indexOf("variable");
                break;
            // Standard enums (use our constants)
            case classificationTypeClassName:
                typeIndex = legend.tokenTypes.indexOf("class");
                break;
            case classificationTypeEnumName: typeIndex = legend.tokenTypes.indexOf("enumMember"); break;
            case classificationTypeInterfaceName: typeIndex = legend.tokenTypes.indexOf("interface"); break;
            case classificationTypeModuleName: typeIndex = legend.tokenTypes.indexOf("namespace"); break;
            case classificationTypeTypeAliasName: typeIndex = legend.tokenTypes.indexOf("type"); break;
            case classificationTypeTypeParameterName: typeIndex = legend.tokenTypes.indexOf("typeParameter"); break;
            case classificationTypeParameterName: typeIndex = legend.tokenTypes.indexOf("parameter"); break;
            case classificationTypeKeyword: typeIndex = legend.tokenTypes.indexOf("keyword"); break;
            case classificationTypeIdentifier:
                // Default to variable if it's an identifier and wasn't mapped otherwise
                if (typeIndex === undefined) typeIndex = legend.tokenTypes.indexOf("variable");
                break;
        }

        if (typeIndex === undefined || typeIndex === -1) {
            log('debug', `[decodeToken] Unmapped classification type: ${type} (Raw: ${classification})`);
            return undefined;
        }

        let modifierSet = 0;
        const tokenClassDeclarationMask = 256;
        const tokenClassReadonlyMask = 512;
        const declarationModifierIndex = legend.tokenModifiers.indexOf("declaration");
        const readonlyModifierIndex = legend.tokenModifiers.indexOf("readonly");
        if (modifier & tokenClassDeclarationMask && declarationModifierIndex !== -1) {
            modifierSet |= (1 << declarationModifierIndex);
        }
        if (modifier & tokenClassReadonlyMask && readonlyModifierIndex !== -1) {
            modifierSet |= (1 << readonlyModifierIndex);
        }

        return { typeIndex, modifierSet };
    }
    return undefined;
} 