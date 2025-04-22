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
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { AureliaDocumentInfo } from '../common/types'; 
import { log } from '../utils/logger';

// Define the legend for semantic tokens
const tokenTypes = [
    SemanticTokenTypes.variable, SemanticTokenTypes.property, SemanticTokenTypes.function, 
    SemanticTokenTypes.method, SemanticTokenTypes.keyword, SemanticTokenTypes.class, 
    SemanticTokenTypes.type, SemanticTokenTypes.parameter
];
const tokenModifiers = [
    SemanticTokenModifiers.declaration, SemanticTokenModifiers.definition, 
    SemanticTokenModifiers.readonly
];
// Export the legend for use in server capabilities
export const legend: SemanticTokensLegend = {
    tokenTypes: tokenTypes,
    tokenModifiers: tokenModifiers
};

/**
 * Handles semantic tokens requests.
 */
export async function handleSemanticTokensRequest(
    params: SemanticTokensParams,
    documents: TextDocuments<TextDocument>,
    aureliaDocuments: Map<string, AureliaDocumentInfo>,
    virtualFiles: Map<string, { content: string; version: number }>, // Need virtualFiles for mapping
    languageService: ts.LanguageService
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

        for (let i = 0; i < classifications.spans.length; i += 3) {
            const virtualStart = classifications.spans[i];
            const virtualLength = classifications.spans[i + 1];
            const classification = classifications.spans[i + 2];
            const virtualEnd = virtualStart + virtualLength;
            
            const decoded = decodeToken(classification);
            if (!decoded) continue; 

            // --- Map Virtual Span back to HTML Range --- 
            let mapped = false;
            for (const mapping of docInfo.mappings) {
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
                        if (line === endPos.line) {
                            length = endPos.character - startPos.character;
                        } else {
                            const text = document.getText().substring(clampedHtmlStart, clampedHtmlEnd);
                            length = text.length; 
                        }

                        if (length > 0) {
                           builder.push(line, startChar, length, decoded.typeIndex, decoded.modifierSet);
                           mapped = true;
                           break; 
                        }
                    }
                }
            }
        }

    } catch (e) {
        log('error', `[semanticTokens] Error getting semantic classifications: ${e}`);
        return { data: [] }; 
    }

    log('info', `[semanticTokens] Built tokens for ${uri}`);
    return builder.build();
}


/**
 * Helper to decode TS Semantic Classification
 * IMPORTANT: This relies on internal TS classification types/values which might change.
 */
function decodeToken(classification: number): { typeIndex: number; modifierSet: number } | undefined {
    const semanticClassificationFormatShift = 8;
    // Hardcoding common values as enum members might vary
    const classificationTypePropertyName = 9;
    const classificationTypeFunctionName = 10;
    const classificationTypeMethodName = 11;
    const classificationTypeVariableName = 7; 
  
    if (classification > semanticClassificationFormatShift) {
        const type = (classification >> semanticClassificationFormatShift) - 1;
        const modifier = classification & ((1 << semanticClassificationFormatShift) - 1);
  
        let typeIndex: number | undefined = undefined;
        switch (type) {
            case classificationTypeMethodName: // 11
                typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.method);
                break;
            case classificationTypeFunctionName: // 10
                typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.function);
                break;
            case classificationTypePropertyName: // 9
                typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.property);
                break;
            case classificationTypeVariableName: // 7
                typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.variable);
                break;
            // Standard enums (check if they differ from above)
            case ts.ClassificationType.className:
                if (type !== classificationTypeMethodName) typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.class);
                break;
            case ts.ClassificationType.enumName: typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.enumMember); break;
            case ts.ClassificationType.interfaceName: typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.interface); break;
            case ts.ClassificationType.moduleName: typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.namespace); break;
            case ts.ClassificationType.typeAliasName: typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.type); break;
            case ts.ClassificationType.typeParameterName: typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.typeParameter); break;
            case ts.ClassificationType.parameterName: typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.parameter); break;
            case ts.ClassificationType.keyword: typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.keyword); break;
            case ts.ClassificationType.identifier:
                if (typeIndex === undefined) typeIndex = legend.tokenTypes.indexOf(SemanticTokenTypes.variable);
                break;
        }
  
        if (typeIndex === undefined || typeIndex === -1) {
            log('debug', `[decodeToken] Unmapped classification type: ${type} (Raw: ${classification})`);
            return undefined;
        }
  
        let modifierSet = 0;
        const tokenClassDeclarationMask = 256; 
        const tokenClassReadonlyMask = 512; 
        if (modifier & tokenClassDeclarationMask) {
            const modifierIndex = legend.tokenModifiers.indexOf(SemanticTokenModifiers.declaration);
            if (modifierIndex !== -1) modifierSet |= (1 << modifierIndex);
        }
        if (modifier & tokenClassReadonlyMask) {
            const modifierIndex = legend.tokenModifiers.indexOf(SemanticTokenModifiers.readonly);
            if (modifierIndex !== -1) modifierSet |= (1 << modifierIndex);
        }
  
        return { typeIndex, modifierSet };
    }
    return undefined;
  } 